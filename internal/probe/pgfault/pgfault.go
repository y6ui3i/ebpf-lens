// Package pgfault measures page faults with eBPF (fentry/fexit on handle_mm_fault): minor faults counted and
// major faults — the page had to come from disk — timed per process, with the anonymous ones (swap-ins) told apart.
package pgfault

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -tags linux -cc clang -cflags "-O2 -g -Wall" -target amd64 pgfault pgfault.bpf.c -- -I../../../bpf/headers

import (
	"errors"
	"fmt"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"

	"github.com/y6ui3i/ebpf-lens/internal/model"
	"github.com/y6ui3i/ebpf-lens/internal/probe"
)

// MaxSlots must match MAX_SLOTS on the BPF side.
const MaxSlots = 27

// Probe holds the loaded BPF objects and the attached links.
type Probe struct {
	objs  pgfaultObjects
	links []link.Link
	prev  [MaxSlots]uint64
}

// Open loads the programs and attaches them to handle_mm_fault.
func Open() (*Probe, error) {
	p := &Probe{}
	if err := loadPgfaultObjects(&p.objs, nil); err != nil {
		return nil, fmt.Errorf("load bpf objects: %w", err)
	}
	for _, prog := range []*ebpf.Program{p.objs.HandleFault, p.objs.HandleFaultRet} {
		l, err := link.AttachTracing(link.TracingOptions{Program: prog})
		if err != nil {
			p.Close()
			return nil, fmt.Errorf("attach %s: %w", prog, err)
		}
		p.links = append(p.links, l)
	}
	return p, nil
}

// Delta returns, per slot, how many major faults completed with that latency since the previous call.
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

// Procs reads and clears the per-process aggregates. In the result, Wait* means "time stalled in major page
// faults" (count, total, max); MinorFaults and SwapIns are the other counters. The totals are returned too.
func (p *Probe) Procs(label func(tgid uint32, comm string) string) ([]model.ProcStat, model.FaultStat, error) {
	var (
		key  pgfaultProcKey
		val  pgfaultProcVal
		keys []pgfaultProcKey
		tot  model.FaultStat
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
		s.MinorFaults += val.Minor
		s.WaitCount += val.Major
		s.SwapIns += val.Swapin
		s.WaitNs += val.MajorNs
		s.WaitMaxNs = max(s.WaitMaxNs, val.MajorMaxNs)
		for i, c := range val.Slots {
			s.Slots[i] += c
		}
		tot.Minor += val.Minor
		tot.Major += val.Major
		tot.SwapIn += val.Swapin
		tot.MajorNs += val.MajorNs
	}
	if err := it.Err(); err != nil {
		return nil, tot, fmt.Errorf("iterate procs: %w", err)
	}
	for i := range keys {
		_ = p.objs.Procs.Delete(&keys[i])
	}
	out := make([]model.ProcStat, 0, len(byComm))
	for _, s := range byComm {
		out = append(out, *s)
	}
	return out, tot, nil
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
