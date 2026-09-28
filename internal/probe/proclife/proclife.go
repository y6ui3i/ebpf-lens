// Package proclife captures process start, exit, and OOM kill as events with eBPF.
package proclife

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -tags linux -cc clang -cflags "-O2 -g -Wall" -target amd64 -type event proclife proclife.bpf.c -- -I../../../bpf/headers

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"time"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"
	"github.com/cilium/ebpf/ringbuf"
	"golang.org/x/sys/unix"

	"github.com/y6ui3i/ebpf-lens/internal/model"
	"github.com/y6ui3i/ebpf-lens/internal/probe"
)

const (
	kindExec = 1
	kindExit = 2
	kindOOM  = 3
	kindSig  = 4
)

type Probe struct {
	objs  proclifeObjects
	links []link.Link
	rd    *ringbuf.Reader
	// offset for converting CLOCK_MONOTONIC (the BPF-side clock) to wall-clock time
	monoToWall time.Duration
	prevDrop   uint64
}

// Open loads the BPF programs and attaches them to the exec / exit tracepoints and to oom_kill_process.
func Open() (*Probe, error) {
	p := &Probe{}
	if err := loadProclifeObjects(&p.objs, nil); err != nil {
		return nil, fmt.Errorf("load bpf objects: %w", err)
	}
	for _, prog := range []*ebpf.Program{p.objs.HandleExec, p.objs.HandleExit, p.objs.HandleOom, p.objs.HandleSignal} {
		l, err := link.AttachTracing(link.TracingOptions{Program: prog})
		if err != nil {
			p.Close()
			return nil, fmt.Errorf("attach %s: %w", prog, err)
		}
		p.links = append(p.links, l)
	}
	rd, err := ringbuf.NewReader(p.objs.Events)
	if err != nil {
		p.Close()
		return nil, fmt.Errorf("ringbuf: %w", err)
	}
	p.rd = rd

	var ts unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_MONOTONIC, &ts); err != nil {
		p.Close()
		return nil, fmt.Errorf("clock_gettime: %w", err)
	}
	p.monoToWall = time.Duration(time.Now().UnixNano() - ts.Nano())
	return p, nil
}

// Run keeps reading the ring buffer and sends events to out. It returns once Close is called.
// When out is full, the event is dropped and onDrop is called (so collection is never blocked).
func (p *Probe) Run(out chan<- model.ProcEvent, onDrop func()) error {
	var raw proclifeEvent
	for {
		rec, err := p.rd.Read()
		if err != nil {
			if errors.Is(err, ringbuf.ErrClosed) {
				return nil
			}
			return fmt.Errorf("ringbuf read: %w", err)
		}
		if err := binary.Read(bytes.NewReader(rec.RawSample), binary.NativeEndian, &raw); err != nil {
			return fmt.Errorf("decode event: %w", err)
		}
		select {
		case out <- p.convert(&raw):
		default:
			onDrop()
		}
	}
}

func (p *Probe) convert(r *proclifeEvent) model.ProcEvent {
	e := model.ProcEvent{
		Time: time.Unix(0, int64(r.Ts)+int64(p.monoToWall)),
		Pid:  r.Pid,
		Ppid: r.Ppid,
		UID:  r.Uid,
		Comm: probe.CString(r.Comm[:]),
	}
	switch r.Kind {
	case kindExec:
		e.Kind = "exec"
		e.Filename = probe.CString(r.Filename[:])
	case kindExit:
		e.Kind = "exit"
		// Same interpretation as wait(2): the low 7 bits are the signal, 0x80 is core dump, the high 8 bits are the exit code
		code := r.ExitCode
		e.Signal = int(code & 0x7f)
		e.CoreDump = code&0x80 != 0
		e.ExitStatus = int((code >> 8) & 0xff)
		e.LifetimeNs = r.LifetimeNs
	case kindSig:
		// A terminating signal sent to this process: Signal is the signal, Trigger* is who sent it
		e.Kind = "signal"
		e.Signal = int(r.ExitCode)
		e.TriggerPid = r.TriggerPid
		e.TriggerComm = probe.CString(r.TriggerComm[:])
	case kindOOM:
		e.Kind = "oom"
		e.TriggerPid = r.TriggerPid
		e.TriggerComm = probe.CString(r.TriggerComm[:])
		e.TotalPages = r.TotalPages
		e.Memcg = r.Memcg != 0
	}
	return e
}

// DroppedDelta returns the increase since the previous call in the number of events the kernel dropped because the ring buffer overflowed.
func (p *Probe) DroppedDelta() (uint64, error) {
	var perCPU []uint64
	if err := p.objs.Dropped.Lookup(uint32(0), &perCPU); err != nil {
		return 0, err
	}
	var sum uint64
	for _, v := range perCPU {
		sum += v
	}
	d := sum - p.prevDrop
	p.prevDrop = sum
	return d, nil
}

func (p *Probe) Close() error {
	var errs []error
	if p.rd != nil {
		errs = append(errs, p.rd.Close())
	}
	for _, l := range p.links {
		errs = append(errs, l.Close())
	}
	errs = append(errs, p.objs.Close())
	return errors.Join(errs...)
}
