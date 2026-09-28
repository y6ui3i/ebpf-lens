// Package biolat collects block I/O latency (issue to completion) as a log2 histogram with eBPF, plus
// per-device totals (I/Os, bytes, errors) and per-process totals (who issued the I/O).
package biolat

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -tags linux -cc clang -cflags "-O2 -g -Wall" -target amd64 biolat biolat.bpf.c -- -I../../../bpf/headers

import (
	"errors"
	"fmt"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"

	"github.com/y6ui3i/ebpf-lens/internal/model"
	"github.com/y6ui3i/ebpf-lens/internal/probe"
)

// MaxSlots must match MAX_SLOTS on the BPF side (the same log2 µs slots as runqlat).
const MaxSlots = 27

// Probe holds the loaded BPF objects and the attached links.
type Probe struct {
	objs  biolatObjects
	links []link.Link
	prev  [MaxSlots]uint64
}

// Open loads the BPF programs and attaches them to the block tracepoints.
func Open() (*Probe, error) {
	p := &Probe{}
	if err := loadBiolatObjects(&p.objs, nil); err != nil {
		return nil, fmt.Errorf("load bpf objects: %w", err)
	}
	for _, prog := range []*ebpf.Program{p.objs.HandleBioQueue, p.objs.HandleSplit, p.objs.HandleBioComplete, p.objs.HandleRqIssue, p.objs.HandleRqComplete} {
		l, err := link.AttachTracing(link.TracingOptions{Program: prog})
		if err != nil {
			p.Close()
			return nil, fmt.Errorf("attach %s: %w", prog, err)
		}
		p.links = append(p.links, l)
	}
	return p, nil
}

// Delta returns, per slot, how many I/Os completed with that latency since the previous call.
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

// Procs reads and clears the per-process aggregates and merges them by name. In the result, Wait* means
// "latency of the I/O this process issued" (count, total, max), and ReadBytes / WriteBytes what it moved.
func (p *Probe) Procs(label func(tgid uint32, comm string) string) ([]model.ProcStat, error) {
	var (
		key  biolatProcKey
		val  biolatProcVal
		keys []biolatProcKey
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
		s.WaitCount += val.Reads + val.Writes
		s.WaitNs += val.LatNs
		s.WaitMaxNs = max(s.WaitMaxNs, val.LatMaxNs)
		s.ReadBytes += val.ReadBytes
		s.WriteBytes += val.WriteBytes
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

// Devices reads and clears the per-device aggregates.
func (p *Probe) Devices() ([]model.DiskDev, error) {
	var (
		key  biolatDevKey
		val  biolatDevVal
		keys []biolatDevKey
		out  []model.DiskDev
	)
	it := p.objs.Devs.Iterate()
	for it.Next(&key, &val) {
		keys = append(keys, key)
		d := model.DiskDev{
			Name: probe.CString(key.Name[:]), Reads: val.Reads, Writes: val.Writes,
			ReadBytes: val.ReadBytes, WriteBytes: val.WriteBytes, Errors: val.Errors,
			LatNs: val.LatNs, LatMaxNs: val.LatMaxNs, Slots: make([]uint64, MaxSlots),
		}
		copy(d.Slots, val.Slots[:])
		out = append(out, d)
	}
	if err := it.Err(); err != nil {
		return nil, fmt.Errorf("iterate devs: %w", err)
	}
	for i := range keys {
		_ = p.objs.Devs.Delete(&keys[i])
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
