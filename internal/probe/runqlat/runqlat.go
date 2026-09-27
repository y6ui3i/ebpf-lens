// Package runqlat collects a log2 histogram of run queue latency
// (from wakeup until the task gets on a CPU) with eBPF.
package runqlat

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -tags linux -cc clang -cflags "-O2 -g -Wall" -target amd64 runqlat runqlat.bpf.c -- -I../../../bpf/headers

import (
	"errors"
	"fmt"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"

	"github.com/yoshiharu-ishii/ebpf-lens/internal/model"
	"github.com/yoshiharu-ishii/ebpf-lens/internal/probe"
)

// MaxSlots must match MAX_SLOTS on the BPF side.
// Slot i is [2^i, 2^(i+1)) microseconds (slot 0 alone is 0-1µs).
const MaxSlots = 27

// Probe holds the loaded BPF objects and the attached links.
type Probe struct {
	objs  runqlatObjects
	links []link.Link
	prev  [MaxSlots]uint64
}

// Open loads the BPF programs and attaches them to the sched tracepoints.
func Open() (*Probe, error) {
	p := &Probe{}
	if err := loadRunqlatObjects(&p.objs, nil); err != nil {
		return nil, fmt.Errorf("load bpf objects: %w", err)
	}
	for _, prog := range []*ebpf.Program{
		p.objs.HandleSchedWakeup,
		p.objs.HandleSchedWakeupNew,
		p.objs.HandleSchedSwitch,
	} {
		l, err := link.AttachTracing(link.TracingOptions{Program: prog})
		if err != nil {
			p.Close()
			return nil, fmt.Errorf("attach %s: %w", prog, err)
		}
		p.links = append(p.links, l)
	}
	return p, nil
}

// Delta returns, per slot, how many counts were added since the previous call.
// The BPF side counts cumulatively, so the delta is taken in user space.
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

// Procs reads the per-process aggregates, deletes them from the BPF map, and returns them merged by name.
// Anything added between the read and the delete is lost, but that is tiny relative to one interval.
// Procs reads and clears the per-process aggregates and merges them by name. label decides the name a process
// is filed under (the agent uses it to file QEMU processes under "vm:<name>"); nil keeps the kernel's comm.
func (p *Probe) Procs(label func(tgid uint32, comm string) string) ([]model.ProcStat, error) {
	var (
		key  runqlatProcKey
		val  runqlatProcVal
		keys []runqlatProcKey
	)
	byComm := map[string]*model.ProcStat{}
	it := p.objs.Procs.Iterate()
	for it.Next(&key, &val) {
		keys = append(keys, key)
		comm := probe.CString(key.Comm[:])
		if label != nil {
			comm = label(key.Tgid, comm)
		}
		s, ok := byComm[comm]
		if !ok {
			s = &model.ProcStat{Comm: comm, Slots: make([]uint64, MaxSlots)}
			byComm[comm] = s
		}
		s.Procs++
		if len(s.Pids) < maxPids {
			s.Pids = append(s.Pids, key.Tgid)
		}
		s.OnCPUNs += val.OncpuNs
		s.WaitCount += val.WaitCount
		s.WaitNs += val.WaitNs
		s.WaitMaxNs = max(s.WaitMaxNs, val.WaitMaxNs)
		for i, c := range val.Slots {
			s.Slots[i] += c
		}
	}
	if err := it.Err(); err != nil {
		return nil, fmt.Errorf("iterate procs: %w", err)
	}
	for i := range keys {
		// Entries may already be gone (e.g. the process exited in the meantime), so ignore errors
		_ = p.objs.Procs.Delete(&keys[i])
	}

	out := make([]model.ProcStat, 0, len(byComm))
	for _, s := range byComm {
		out = append(out, *s)
	}
	return out, nil
}

const maxPids = 5

// Close detaches the links and releases the BPF objects.
func (p *Probe) Close() error {
	var errs []error
	for _, l := range p.links {
		errs = append(errs, l.Close())
	}
	errs = append(errs, p.objs.Close())
	return errors.Join(errs...)
}
