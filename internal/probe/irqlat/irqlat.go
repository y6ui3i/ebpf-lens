// Package irqlat measures time spent in interrupt context: soft interrupts per CPU and vector, hard interrupts
// per handler name and per CPU, with a histogram of one softirq's run time.
package irqlat

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -tags linux -cc clang -cflags "-O2 -g -Wall" -target amd64 irqlat irqlat.bpf.c -- -I../../../bpf/headers

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

// nrVecs must match NR_VECS on the BPF side.
const nrVecs = 16

// Softirq vector names (include/linux/interrupt.h).
var vecNames = [...]string{"HI", "TIMER", "NET_TX", "NET_RX", "BLOCK", "IRQ_POLL", "TASKLET", "SCHED", "HRTIMER", "RCU"}

// Probe holds the loaded BPF objects and the attached links.
type Probe struct {
	objs    irqlatObjects
	links   []link.Link
	prev    [MaxSlots]uint64
	prevCPU []irqlatCountNs
}

// Open loads the programs and attaches them to the irq tracepoints.
func Open() (*Probe, error) {
	p := &Probe{}
	if err := loadIrqlatObjects(&p.objs, nil); err != nil {
		return nil, fmt.Errorf("load bpf objects: %w", err)
	}
	for _, prog := range []*ebpf.Program{p.objs.HandleSoftirqEntry, p.objs.HandleSoftirqExit, p.objs.HandleIrqEntry, p.objs.HandleIrqExit} {
		l, err := link.AttachTracing(link.TracingOptions{Program: prog})
		if err != nil {
			p.Close()
			return nil, fmt.Errorf("attach %s: %w", prog, err)
		}
		p.links = append(p.links, l)
	}
	return p, nil
}

// Delta returns, per slot, how many softirqs ran for that long since the previous call.
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

// Read drains the per-(cpu, vector) softirq and per-irq aggregates and reads the per-CPU hardirq totals (as deltas).
func (p *Probe) Read() (model.IRQStat, error) {
	var st model.IRQStat
	cpuSoft := map[int]uint64{}

	var (
		sk   uint32
		sv   irqlatCountNs
		skey []uint32
	)
	it := p.objs.Soft.Iterate()
	for it.Next(&sk, &sv) {
		skey = append(skey, sk)
		cpu, vec := int(sk/nrVecs), int(sk%nrVecs)
		name := "OTHER"
		if vec < len(vecNames) {
			name = vecNames[vec]
		}
		st.Softirqs = append(st.Softirqs, model.SoftirqStat{Vec: name, CPU: cpu, Count: sv.Count, Ns: sv.Ns})
		cpuSoft[cpu] += sv.Ns
	}
	if err := it.Err(); err != nil {
		return st, fmt.Errorf("iterate softirqs: %w", err)
	}
	for i := range skey {
		_ = p.objs.Soft.Delete(&skey[i])
	}

	var (
		ik   uint32
		iv   irqlatIrqVal
		ikey []uint32
	)
	it = p.objs.Irqs.Iterate()
	for it.Next(&ik, &iv) {
		ikey = append(ikey, ik)
		st.IRQs = append(st.IRQs, model.HardIRQ{IRQ: int(ik), Name: probe.CString(iv.Name[:]), Count: iv.Count, Ns: iv.Ns})
	}
	if err := it.Err(); err != nil {
		return st, fmt.Errorf("iterate irqs: %w", err)
	}
	for i := range ikey {
		_ = p.objs.Irqs.Delete(&ikey[i])
	}

	// Hardirq time per CPU is a cumulative per-CPU counter; the per-CPU slice index is the CPU number
	var perCPU []irqlatCountNs
	if err := p.objs.IrqCpu.Lookup(uint32(0), &perCPU); err != nil {
		return st, fmt.Errorf("lookup irq per cpu: %w", err)
	}
	if len(p.prevCPU) != len(perCPU) {
		p.prevCPU = make([]irqlatCountNs, len(perCPU))
	}
	for cpu, v := range perCPU {
		d := irqlatCountNs{Count: v.Count - p.prevCPU[cpu].Count, Ns: v.Ns - p.prevCPU[cpu].Ns}
		p.prevCPU[cpu] = v
		if d.Ns > 0 || cpuSoft[cpu] > 0 {
			st.CPUs = append(st.CPUs, model.CPUIRQ{CPU: cpu, SoftirqNs: cpuSoft[cpu], IRQNs: d.Ns, IRQCount: d.Count})
			delete(cpuSoft, cpu)
		}
	}
	for cpu, ns := range cpuSoft {
		st.CPUs = append(st.CPUs, model.CPUIRQ{CPU: cpu, SoftirqNs: ns})
	}
	return st, nil
}

// Close detaches the links and releases the BPF objects.
func (p *Probe) Close() error {
	var errs []error
	for _, l := range p.links {
		errs = append(errs, l.Close())
	}
	errs = append(errs, p.objs.Close())
	return errors.Join(errs...)
}
