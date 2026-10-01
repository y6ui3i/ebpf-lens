// Package lockwait measures time spent waiting for locks: contended user-space locks through the futex syscall
// (a lock is an address two or more threads waited on; a thread parked on its own address is not), and kernel
// lock contention through the lock:contention_begin/end tracepoints, per kind and per process.
package lockwait

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -tags linux -cc clang -cflags "-O2 -g -Wall" -target amd64 lockwait lockwait.bpf.c -- -I../../../bpf/headers

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

// kindNames must match kind_of on the BPF side.
var kindNames = [...]string{"mutex", "rwsem-read", "rwsem-write", "spinlock", "rtmutex", "percpu-rwsem", "other", "other"}

// Probe holds the loaded BPF objects and the attached links.
type Probe struct {
	objs      lockwaitObjects
	links     []link.Link
	prevKinds [len(kindNames)]lockwaitKindVal
	// Warning is set when the kernel lock tracepoints could not be attached (a kernel before 5.19); user-space
	// lock waits still work
	Warning string
}

// Open loads the programs and attaches them: the raw syscall tracepoints (futex) and the lock contention tracepoints.
func Open() (*Probe, error) {
	p := &Probe{}
	if err := loadLockwaitObjects(&p.objs, nil); err != nil {
		return nil, fmt.Errorf("load bpf objects: %w", err)
	}
	for _, prog := range []*ebpf.Program{p.objs.HandleSysEnter, p.objs.HandleSysExit} {
		l, err := link.AttachTracing(link.TracingOptions{Program: prog})
		if err != nil {
			p.Close()
			return nil, fmt.Errorf("attach %s: %w", prog, err)
		}
		p.links = append(p.links, l)
	}
	for _, prog := range []*ebpf.Program{p.objs.HandleContentionBegin, p.objs.HandleContentionEnd} {
		l, err := link.AttachTracing(link.TracingOptions{Program: prog})
		if err != nil {
			p.Warning = fmt.Sprintf("attach %s: %v; kernel lock waits go uncounted", prog, err)
			break
		}
		p.links = append(p.links, l)
	}
	return p, nil
}

// Result is one interval of lock waits.
type Result struct {
	Slots  [MaxSlots]uint64 // histogram of contended user-lock waits (µs)
	Procs  []model.ProcStat // per process (merged by name): Wait* = contended user-lock waits, KernelLock* = kernel lock waits
	Stat   model.LockStat
	Parked uint64 // single-waiter futex time (ns): threads parked on their own address, not counted as lock waits
}

// Read drains the maps and returns the interval's lock waits.
func (p *Probe) Read(label func(tgid uint32, comm string) string) (Result, error) {
	var r Result
	byComm := map[string]*model.ProcStat{}
	procOf := func(tgid uint32, comm string) *model.ProcStat {
		if label != nil {
			comm = label(tgid, comm)
		}
		s, ok := byComm[comm]
		if !ok {
			s = &model.ProcStat{Comm: comm, Slots: make([]uint64, MaxSlots)}
			byComm[comm] = s
		}
		return s
	}

	// User-space locks: one entry per (process, address); only the addresses with two or more waiters are locks
	var (
		uk   lockwaitUlockKey
		uv   lockwaitUlockVal
		ukey []lockwaitUlockKey
	)
	seen := map[string]map[uint32]bool{} // comm -> tgids, for Procs
	it := p.objs.Ulocks.Iterate()
	for it.Next(&uk, &uv) {
		ukey = append(ukey, uk)
		if uv.Waiters < 2 {
			r.Parked += uv.Ns
			continue
		}
		s := procOf(uk.Tgid, probe.CString(uv.Comm[:]))
		if seen[s.Comm] == nil {
			seen[s.Comm] = map[uint32]bool{}
		}
		if !seen[s.Comm][uk.Tgid] {
			seen[s.Comm][uk.Tgid] = true
			s.Procs++
			if len(s.Pids) < maxPids {
				s.Pids = append(s.Pids, uk.Tgid)
			}
		}
		s.Locks++
		s.WaitCount += uv.Waits
		s.WaitNs += uv.Ns
		s.WaitMaxNs = max(s.WaitMaxNs, uv.MaxNs)
		r.Stat.UserWaits += uv.Waits
		r.Stat.UserNs += uv.Ns
		for i, c := range uv.Slots {
			s.Slots[i] += c
			r.Slots[i] += c
		}
	}
	if err := it.Err(); err != nil {
		return r, fmt.Errorf("iterate ulocks: %w", err)
	}
	for i := range ukey {
		_ = p.objs.Ulocks.Delete(&ukey[i])
	}

	// Kernel locks per process
	var (
		kk   lockwaitProcKey
		kv   lockwaitKprocVal
		kkey []lockwaitProcKey
	)
	it = p.objs.Kprocs.Iterate()
	for it.Next(&kk, &kv) {
		kkey = append(kkey, kk)
		if kk.Tgid == 0 {
			continue // the idle task (swapper) spinning on a lock is the kernel's business, not a process waiting
		}
		s := procOf(kk.Tgid, probe.CString(kk.Comm[:]))
		if seen[s.Comm] == nil {
			seen[s.Comm] = map[uint32]bool{}
		}
		if !seen[s.Comm][kk.Tgid] {
			seen[s.Comm][kk.Tgid] = true
			s.Procs++
			if len(s.Pids) < maxPids {
				s.Pids = append(s.Pids, kk.Tgid)
			}
		}
		s.KernelLockCount += kv.Waits
		s.KernelLockNs += kv.Ns
	}
	if err := it.Err(); err != nil {
		return r, fmt.Errorf("iterate kprocs: %w", err)
	}
	for i := range kkey {
		_ = p.objs.Kprocs.Delete(&kkey[i])
	}

	// Kernel locks by kind (cumulative per-CPU counters: deltas since the previous call)
	for idx := uint32(0); idx < uint32(len(kindNames)); idx++ {
		var perCPU []lockwaitKindVal
		if err := p.objs.Kinds.Lookup(idx, &perCPU); err != nil {
			return r, fmt.Errorf("lookup kind %d: %w", idx, err)
		}
		var sum lockwaitKindVal
		for _, v := range perCPU {
			sum.Waits += v.Waits
			sum.Ns += v.Ns
			sum.MaxNs = max(sum.MaxNs, v.MaxNs)
		}
		d := lockwaitKindVal{Waits: sum.Waits - p.prevKinds[idx].Waits, Ns: sum.Ns - p.prevKinds[idx].Ns, MaxNs: sum.MaxNs}
		p.prevKinds[idx] = sum
		if d.Waits > 0 {
			// MaxNs is a running maximum on the BPF side; the interval's own maximum is not tracked separately
			r.Stat.Kernel = append(r.Stat.Kernel, model.KernelLock{Kind: kindNames[idx], Count: d.Waits, LatNs: d.Ns})
		}
	}

	r.Procs = make([]model.ProcStat, 0, len(byComm))
	for _, s := range byComm {
		r.Procs = append(r.Procs, *s)
	}
	return r, nil
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
