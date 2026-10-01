// Package irqlat measures time spent in interrupt context: soft interrupts per CPU and vector, hard interrupts
// per IRQ line and per CPU, with a histogram of one softirq's run time. The BPF side is lock-free (per-CPU arrays
// only; see irqlat.bpf.c for why); the IRQ names come from /proc/interrupts.
package irqlat

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -tags linux -cc clang -cflags "-O2 -g -Wall" -target amd64 irqlat irqlat.bpf.c -- -I../../../bpf/headers

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"

	"github.com/y6ui3i/ebpf-lens/internal/model"
)

// MaxSlots must match MAX_SLOTS on the BPF side.
const MaxSlots = 27

// nrVecs and maxIRQs must match NR_VECS and MAX_IRQS on the BPF side.
const (
	nrVecs  = 16
	maxIRQs = 512
)

// Softirq vector names (include/linux/interrupt.h).
var vecNames = [...]string{"HI", "TIMER", "NET_TX", "NET_RX", "BLOCK", "IRQ_POLL", "TASKLET", "SCHED", "HRTIMER", "RCU"}

// Probe holds the loaded BPF objects and the attached links.
type Probe struct {
	objs     irqlatObjects
	links    []link.Link
	prev     [MaxSlots]uint64
	prevSoft [nrVecs][]irqlatCountNs // cumulative per-CPU counters at the previous read
	prevIRQ  [maxIRQs][]irqlatCountNs
	names    map[int]string // irq number -> name from /proc/interrupts
	namesAt  time.Time
}

// Open loads the programs and attaches them to the irq tracepoints.
func Open() (*Probe, error) {
	p := &Probe{names: map[int]string{}}
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

// Read returns the interval's interrupt time from the cumulative per-CPU counters (deltas since the previous call).
func (p *Probe) Read() (model.IRQStat, error) {
	var st model.IRQStat
	cpuSoft := map[int]uint64{}
	cpuIRQ := map[int]*model.CPUIRQ{}

	for vec := uint32(0); vec < nrVecs; vec++ {
		var perCPU []irqlatCountNs
		if err := p.objs.Soft.Lookup(vec, &perCPU); err != nil {
			return st, fmt.Errorf("lookup vec %d: %w", vec, err)
		}
		if len(p.prevSoft[vec]) != len(perCPU) {
			p.prevSoft[vec] = make([]irqlatCountNs, len(perCPU))
		}
		name := "OTHER"
		if int(vec) < len(vecNames) {
			name = vecNames[vec]
		}
		for cpu, v := range perCPU {
			d := irqlatCountNs{Count: v.Count - p.prevSoft[vec][cpu].Count, Ns: v.Ns - p.prevSoft[vec][cpu].Ns}
			p.prevSoft[vec][cpu] = v
			if d.Count == 0 {
				continue
			}
			st.Softirqs = append(st.Softirqs, model.SoftirqStat{Vec: name, CPU: cpu, Count: d.Count, Ns: d.Ns})
			cpuSoft[cpu] += d.Ns
		}
	}

	p.refreshNames()
	for irq := uint32(0); irq < maxIRQs; irq++ {
		var perCPU []irqlatCountNs
		if err := p.objs.Irqs.Lookup(irq, &perCPU); err != nil {
			return st, fmt.Errorf("lookup irq %d: %w", irq, err)
		}
		if len(p.prevIRQ[irq]) != len(perCPU) {
			p.prevIRQ[irq] = make([]irqlatCountNs, len(perCPU))
		}
		var total irqlatCountNs
		for cpu, v := range perCPU {
			d := irqlatCountNs{Count: v.Count - p.prevIRQ[irq][cpu].Count, Ns: v.Ns - p.prevIRQ[irq][cpu].Ns}
			p.prevIRQ[irq][cpu] = v
			if d.Count == 0 {
				continue
			}
			total.Count += d.Count
			total.Ns += d.Ns
			c := cpuIRQ[cpu]
			if c == nil {
				c = &model.CPUIRQ{CPU: cpu}
				cpuIRQ[cpu] = c
			}
			c.IRQNs += d.Ns
			c.IRQCount += d.Count
		}
		if total.Count > 0 {
			name := p.names[int(irq)]
			if name == "" {
				name = fmt.Sprintf("irq%d", irq)
			}
			st.IRQs = append(st.IRQs, model.HardIRQ{IRQ: int(irq), Name: name, Count: total.Count, Ns: total.Ns})
		}
	}

	for cpu, ns := range cpuSoft {
		c := cpuIRQ[cpu]
		if c == nil {
			c = &model.CPUIRQ{CPU: cpu}
			cpuIRQ[cpu] = c
		}
		c.SoftirqNs = ns
	}
	for _, c := range cpuIRQ {
		st.CPUs = append(st.CPUs, *c)
	}
	return st, nil
}

// refreshNames re-reads /proc/interrupts every 10 s: "  44:  123  456  IR-PCI-MSI-0000:04:00.0 0-edge  ahci[0000:04:00.0]".
// The name is the last field (several words joined when a line has them, e.g. "nvme0q3" or "ahci[0000:04:00.0]").
func (p *Probe) refreshNames() {
	if time.Since(p.namesAt) < 10*time.Second {
		return
	}
	p.namesAt = time.Now()
	f, err := os.Open("/proc/interrupts")
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	ncpu := 0
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 0 {
			continue
		}
		if ncpu == 0 && strings.HasPrefix(fields[0], "CPU") {
			ncpu = len(fields)
			continue
		}
		n, err := strconv.Atoi(strings.TrimSuffix(fields[0], ":"))
		if err != nil || len(fields) < 2+ncpu {
			continue
		}
		rest := fields[1+ncpu:] // chip name, flow type, then the action names
		if len(rest) == 0 {
			continue
		}
		p.names[n] = rest[len(rest)-1]
	}
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
