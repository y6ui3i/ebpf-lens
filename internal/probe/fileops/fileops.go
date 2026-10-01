// Package fileops watches two things about files with eBPF: opens that fail (which process, which path, which
// errno — the first sign of most misconfigurations) and fsync waits (how long a process sat in fsync, on which
// file — the wait a database commit feels when the disk stalls).
package fileops

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -tags linux -cc clang -cflags "-O2 -g -Wall" -target amd64 fileops fileops.bpf.c -- -I../../../bpf/headers

import (
	"errors"
	"fmt"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"

	"github.com/y6ui3i/ebpf-lens/internal/fileerr"
	"github.com/y6ui3i/ebpf-lens/internal/model"
	"github.com/y6ui3i/ebpf-lens/internal/probe"
)

// MaxSlots must match MAX_SLOTS on the BPF side.
const MaxSlots = 27

// maxErrno must match MAX_ERRNO on the BPF side.
const maxErrno = 256

// Probe holds the loaded BPF objects and the attached links.
type Probe struct {
	objs     fileopsObjects
	links    []link.Link
	prev     [MaxSlots]uint64
	prevErrs [maxErrno]uint64
}

// Open loads the programs and attaches them: the raw syscall enter/exit tracepoints (for open / openat /
// openat2) and fentry/fexit on do_fsync.
func Open() (*Probe, error) {
	p := &Probe{}
	if err := loadFileopsObjects(&p.objs, nil); err != nil {
		return nil, fmt.Errorf("load bpf objects: %w", err)
	}
	for _, prog := range []*ebpf.Program{p.objs.HandleSysEnter, p.objs.HandleSysExit, p.objs.HandleFsync, p.objs.HandleFsyncRet} {
		l, err := link.AttachTracing(link.TracingOptions{Program: prog})
		if err != nil {
			p.Close()
			return nil, fmt.Errorf("attach %s: %w", prog, err)
		}
		p.links = append(p.links, l)
	}
	return p, nil
}

// Delta returns, per slot, how many fsyncs completed with that latency since the previous call.
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

// Procs reads and clears the per-process aggregates. In the result, Wait* means "time spent in fsync" (count,
// total, max) and OpenFails how many opens failed.
func (p *Probe) Procs(label func(tgid uint32, comm string) string) ([]model.ProcStat, error) {
	var (
		key  fileopsProcKey
		val  fileopsProcVal
		keys []fileopsProcKey
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
		s.WaitCount += val.Fsyncs
		s.WaitNs += val.LatNs
		s.WaitMaxNs = max(s.WaitMaxNs, val.LatMaxNs)
		s.OpenFails += val.OpenFails
		for i, c := range val.Slots {
			s.Slots[i] += c
		}
	}
	if err := it.Err(); err != nil {
		return nil, fmt.Errorf("iterate procs: %w", err)
	}
	for i := range keys {
		_ = p.objs.Procs.Delete(&keys[i])
	}
	out := make([]model.ProcStat, 0, len(byComm))
	for _, s := range byComm {
		out = append(out, *s)
	}
	return out, nil
}

// Opens reads and clears the failed opens: the per-errno totals since the previous call, and the rows
// (process, errno, path) with their tier.
func (p *Probe) Opens(label func(tgid uint32, comm string) string) ([]model.FileOpenErr, []model.FileOpenFail, error) {
	var errs []model.FileOpenErr
	for e := uint32(0); e < maxErrno; e++ {
		var perCPU []uint64
		if err := p.objs.OpenErrs.Lookup(e, &perCPU); err != nil {
			return nil, nil, fmt.Errorf("lookup errno %d: %w", e, err)
		}
		var sum uint64
		for _, v := range perCPU {
			sum += v
		}
		if d := sum - p.prevErrs[e]; d > 0 {
			errs = append(errs, model.FileOpenErr{Error: fileerr.Name(e), Count: d})
		}
		p.prevErrs[e] = sum
	}
	var (
		key  fileopsOpenKey
		cnt  uint64
		keys []fileopsOpenKey
	)
	byRow := map[string]*model.FileOpenFail{}
	it := p.objs.Opens.Iterate()
	for it.Next(&key, &cnt) {
		keys = append(keys, key)
		comm := probe.CString(key.Comm[:])
		if label != nil {
			comm = label(key.Tgid, comm)
		}
		name, path := fileerr.Name(key.Err), probe.CString(key.Path[:])
		id := comm + "\x00" + name + "\x00" + path
		r, ok := byRow[id]
		if !ok {
			r = &model.FileOpenFail{Comm: comm, Path: path, Error: name, Tier: fileerr.Tier(name, path)}
			byRow[id] = r
		}
		r.Count += cnt
	}
	if err := it.Err(); err != nil {
		return nil, nil, fmt.Errorf("iterate opens: %w", err)
	}
	for i := range keys {
		_ = p.objs.Opens.Delete(&keys[i])
	}
	rows := make([]model.FileOpenFail, 0, len(byRow))
	for _, r := range byRow {
		rows = append(rows, *r)
	}
	return errs, rows, nil
}

// Files reads and clears the per-file fsync aggregates.
func (p *Probe) Files() ([]model.FileSync, error) {
	var (
		key  fileopsFileKey
		val  fileopsFileVal
		keys []fileopsFileKey
		out  []model.FileSync
	)
	it := p.objs.Files.Iterate()
	for it.Next(&key, &val) {
		keys = append(keys, key)
		name := probe.CString(key.Name[:])
		if dir := probe.CString(key.Dir[:]); dir != "" && dir != "/" { // "/" is a mount root (a file directly under /tmp on tmpfs)
			name = dir + "/" + name
		}
		out = append(out, model.FileSync{Name: name, Fsyncs: val.Fsyncs, LatNs: val.LatNs, LatMaxNs: val.LatMaxNs})
	}
	if err := it.Err(); err != nil {
		return nil, fmt.Errorf("iterate files: %w", err)
	}
	for i := range keys {
		_ = p.objs.Files.Delete(&keys[i])
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
