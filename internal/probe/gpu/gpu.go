// Package gpu watches what CUDA processes do with the GPU: uprobes on libcuda count kernel launches, copies and
// the time spent waiting for the GPU per process (this file), and NVML supplies the GPU's own utilization and
// VRAM (nvml.go). Together they answer "why is the GPU idle" — see docs/adr/0003.
package gpu

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -tags linux -cc clang -cflags "-O2 -g -Wall" -target amd64 gpu gpu.bpf.c -- -I../../../bpf/headers

import (
	"debug/elf"
	"errors"
	"fmt"
	"os"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"

	"github.com/yoshiharu-ishii/ebpf-lens/internal/model"
	"github.com/yoshiharu-ishii/ebpf-lens/internal/probe"
)

// MaxSlots must match MAX_SLOTS on the BPF side (the same log2 µs slots as runqlat).
const MaxSlots = 27

// ErrNoLibcuda means no CUDA driver library was found, so there is nothing to attach to.
var ErrNoLibcuda = errors.New("libcuda.so.1 not found")

// Where the driver library lives on the distributions we know. A process in a container maps the host's file
// (the NVIDIA container toolkit bind-mounts it), so uprobes on the host path see container processes too.
var libcudaPaths = []string{
	"/usr/lib/x86_64-linux-gnu/libcuda.so.1",
	"/usr/lib64/libcuda.so.1",
	"/usr/lib/libcuda.so.1",
	"/usr/lib/aarch64-linux-gnu/libcuda.so.1",
}

// FindLibcuda returns the driver library path, or ErrNoLibcuda.
func FindLibcuda() (string, error) {
	for _, p := range libcudaPaths {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	return "", ErrNoLibcuda
}

// Probe holds the loaded BPF objects and the attached uprobes.
type Probe struct {
	objs  gpuObjects
	links []link.Link
	prev  [MaxSlots]uint64
}

// The exported symbols each program watches. The "_ptsz" and "_v2" variants are the entry points the CUDA runtime
// selects depending on how the application was compiled, so every variant is attached; a symbol an older driver lacks
// is skipped. A launch or sync that reaches one variant does not pass through another, so nothing is counted twice.
var symbols = map[string][]string{
	"launch":   {"cuLaunchKernel", "cuLaunchKernel_ptsz", "cuLaunchKernelEx", "cuLaunchKernelEx_ptsz", "cuGraphLaunch", "cuGraphLaunch_ptsz"},
	"copy_h2d": {"cuMemcpyHtoDAsync_v2", "cuMemcpyHtoDAsync_v2_ptsz", "cuMemcpyHtoDAsync"},
	"copy_d2h": {"cuMemcpyDtoHAsync_v2", "cuMemcpyDtoHAsync_v2_ptsz", "cuMemcpyDtoHAsync"},
	"copy_any": {"cuMemcpyAsync", "cuMemcpyAsync_ptsz"},
	"sync":     {"cuStreamSynchronize", "cuStreamSynchronize_ptsz", "cuCtxSynchronize", "cuEventSynchronize"},
}

// Open loads the BPF programs and attaches them to the CUDA driver library at path (see FindLibcuda).
func Open(path string) (*Probe, error) {
	p := &Probe{}
	if err := loadGpuObjects(&p.objs, nil); err != nil {
		return nil, fmt.Errorf("load bpf objects: %w", err)
	}
	ex, err := link.OpenExecutable(path)
	if err != nil {
		p.Close()
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	exported, err := dynamicSymbols(path)
	if err != nil {
		p.Close()
		return nil, err
	}
	// Entry and return programs per symbol group. The copy groups share one return program
	groups := []struct {
		name       string
		entry, ret *ebpf.Program
	}{
		{"launch", p.objs.HandleLaunch, nil},
		{"copy_h2d", p.objs.HandleCopyH2d, p.objs.HandleCopyRet},
		{"copy_d2h", p.objs.HandleCopyD2h, p.objs.HandleCopyRet},
		{"copy_any", p.objs.HandleCopyAny, p.objs.HandleCopyRet},
		{"sync", p.objs.HandleSync, p.objs.HandleSyncRet},
	}
	attached := 0
	for _, g := range groups {
		var syms []string
		for _, sym := range symbols[g.name] {
			if exported[sym] {
				syms = append(syms, sym)
			}
		}
		if len(syms) == 0 {
			continue
		}
		if err := p.attach(ex, syms, g.entry, false); err != nil {
			p.Close()
			return nil, fmt.Errorf("uprobe %v: %w", syms, err)
		}
		attached += len(syms)
		if g.ret == nil {
			continue
		}
		if err := p.attach(ex, syms, g.ret, true); err != nil {
			p.Close()
			return nil, fmt.Errorf("uretprobe %v: %w", syms, err)
		}
	}
	if attached == 0 {
		p.Close()
		return nil, fmt.Errorf("%s exports none of the CUDA driver symbols we watch", path)
	}
	return p, nil
}

// attach uses the multi-uprobe BPF link (kernel 6.6+, one link for all symbols of a group). It needs only
// CAP_PERFMON, whereas a classic perf_event uprobe is refused to anyone without CAP_SYS_ADMIN on kernels built
// with perf_event_paranoid=4 (Ubuntu) — which is why the agent does not fall back to it.
func (p *Probe) attach(ex *link.Executable, syms []string, prog *ebpf.Program, ret bool) error {
	var l link.Link
	var err error
	if ret {
		l, err = ex.UretprobeMulti(syms, prog, nil)
	} else {
		l, err = ex.UprobeMulti(syms, prog, nil)
	}
	if err != nil {
		return err
	}
	p.links = append(p.links, l)
	return nil
}

// dynamicSymbols lists the functions a shared library exports, so only symbols this driver version has are attached.
func dynamicSymbols(path string) (map[string]bool, error) {
	f, err := elf.Open(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	defer f.Close()
	syms, err := f.DynamicSymbols()
	if err != nil {
		return nil, fmt.Errorf("symbols of %s: %w", path, err)
	}
	out := make(map[string]bool, len(syms))
	for _, s := range syms {
		if elf.ST_TYPE(s.Info) == elf.STT_FUNC && s.Section != elf.SHN_UNDEF {
			out[s.Name] = true
		}
	}
	return out, nil
}

// Delta returns, per slot, how many copy and sync calls waited that long since the previous call.
func (p *Probe) Delta() ([MaxSlots]uint64, error) {
	var out [MaxSlots]uint64
	for slot := uint32(0); slot < MaxSlots; slot++ {
		var perCPU []uint64
		if err := p.objs.Hist.Lookup(slot, &perCPU); err != nil {
			return out, fmt.Errorf("lookup slot %d: %w", slot, err)
		}
		var sum uint64
		for _, v := range perCPU {
			sum += v
		}
		out[slot] = sum - p.prev[slot]
		p.prev[slot] = sum
	}
	return out, nil
}

// Procs reads and clears the per-process aggregates and merges them by name. label decides the name a process is
// filed under (nil keeps the kernel's comm), the same way the other probes do.
func (p *Probe) Procs(label func(tgid uint32, comm string) string) ([]model.GPUProc, error) {
	var (
		key  gpuProcKey
		val  gpuProcVal
		keys []gpuProcKey
	)
	byComm := map[string]*model.GPUProc{}
	it := p.objs.Procs.Iterate()
	for it.Next(&key, &val) {
		keys = append(keys, key)
		comm := probe.CString(key.Comm[:])
		if label != nil {
			comm = label(key.Tgid, comm)
		}
		s, ok := byComm[comm]
		if !ok {
			s = &model.GPUProc{Comm: comm}
			byComm[comm] = s
		}
		s.Procs++
		if len(s.Pids) < maxPids {
			s.Pids = append(s.Pids, key.Tgid)
		}
		s.Launches += val.Launches
		s.H2DBytes += val.H2dBytes
		s.D2HBytes += val.D2hBytes
		s.CopyNs += val.CopyNs
		s.CopyCount += val.CopyCount
		s.SyncNs += val.SyncNs
		s.SyncCount += val.SyncCount
	}
	if err := it.Err(); err != nil {
		return nil, fmt.Errorf("iterate procs: %w", err)
	}
	for i := range keys {
		_ = p.objs.Procs.Delete(&keys[i]) // the process may be gone already
	}
	out := make([]model.GPUProc, 0, len(byComm))
	for _, s := range byComm {
		out = append(out, *s)
	}
	return out, nil
}

const maxPids = 5

// Close detaches the uprobes and releases the BPF objects.
func (p *Probe) Close() error {
	var errs []error
	for _, l := range p.links {
		errs = append(errs, l.Close())
	}
	errs = append(errs, p.objs.Close())
	return errors.Join(errs...)
}
