// Package memstall measures time stalled in memory reclaim (direct reclaim / memcg reclaim) with eBPF.
package memstall

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -tags linux -cc clang -cflags "-O2 -g -Wall" -target amd64 memstall memstall.bpf.c -- -I../../../bpf/headers

import (
	"errors"
	"fmt"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"

	"github.com/y6ui3i/ebpf-lens/internal/model"
	"github.com/y6ui3i/ebpf-lens/internal/probe"
)

// MaxSlots must match MAX_SLOTS on the BPF side. Slot i is [2^i, 2^(i+1)) microseconds.
const MaxSlots = 27

const maxPids = 5

type Probe struct {
	objs  memstallObjects
	links []link.Link
	prev  [MaxSlots]uint64
}

// Open loads the BPF programs and attaches them to the vmscan tracepoints.
func Open() (*Probe, error) {
	p := &Probe{}
	if err := loadMemstallObjects(&p.objs, nil); err != nil {
		return nil, fmt.Errorf("load bpf objects: %w", err)
	}
	for _, prog := range []*ebpf.Program{
		p.objs.HandleDirectBegin, p.objs.HandleDirectEnd,
		p.objs.HandleMemcgBegin, p.objs.HandleMemcgEnd,
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

// Delta returns, per slot, how many stalls were added since the previous call.
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

// Procs reads and deletes the per-process aggregates and returns them merged by name.
// It uses the same ProcStat as runqlat, with Wait* meaning "stalled in reclaim".
// Procs reads and clears the per-process aggregates and merges them by name. label decides the name a process
// is filed under (the agent uses it to file QEMU processes under "vm:<name>"); nil keeps the kernel's comm.
func (p *Probe) Procs(label func(tgid uint32, comm string) string) ([]model.ProcStat, error) {
	var (
		key  memstallProcKey
		val  memstallProcVal
		keys []memstallProcKey
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
		s.WaitCount += val.Count
		s.WaitNs += val.TotalNs
		s.WaitMaxNs = max(s.WaitMaxNs, val.MaxNs)
		s.ReclaimedPages += val.Reclaimed
		s.MemcgCount += val.MemcgCount
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

func (p *Probe) Close() error {
	var errs []error
	for _, l := range p.links {
		errs = append(errs, l.Close())
	}
	errs = append(errs, p.objs.Close())
	return errors.Join(errs...)
}
