// Package proclife はプロセスの起動・終了・OOM kill を eBPF でイベントとして拾う。
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

	"github.com/yoshiharu-ishii/ebpf-lens/internal/model"
	"github.com/yoshiharu-ishii/ebpf-lens/internal/probe"
)

const (
	kindExec = 1
	kindExit = 2
	kindOOM  = 3
)

type Probe struct {
	objs  proclifeObjects
	links []link.Link
	rd    *ringbuf.Reader
	// CLOCK_MONOTONIC(BPF 側の時刻)から壁時計への換算
	monoToWall time.Duration
	prevDrop   uint64
}

// Open は BPF プログラムを読み込み、exec / exit の tracepoint と oom_kill_process にアタッチする。
func Open() (*Probe, error) {
	p := &Probe{}
	if err := loadProclifeObjects(&p.objs, nil); err != nil {
		return nil, fmt.Errorf("load bpf objects: %w", err)
	}
	for _, prog := range []*ebpf.Program{p.objs.HandleExec, p.objs.HandleExit, p.objs.HandleOom} {
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

// Run は ring buffer を読み続け、イベントを out に送る。Close されると戻る。
// out が詰まっているときは捨てて onDrop を呼ぶ(収集側を止めないため)。
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
		// wait(2) と同じ解釈: 下位 7bit がシグナル、0x80 がコアダンプ、上位 8bit が終了コード
		code := r.ExitCode
		e.Signal = int(code & 0x7f)
		e.CoreDump = code&0x80 != 0
		e.ExitStatus = int((code >> 8) & 0xff)
		e.LifetimeNs = r.LifetimeNs
	case kindOOM:
		e.Kind = "oom"
		e.TriggerPid = r.TriggerPid
		e.TriggerComm = probe.CString(r.TriggerComm[:])
		e.TotalPages = r.TotalPages
		e.Memcg = r.Memcg != 0
	}
	return e
}

// DroppedDelta はカーネル側で ring buffer が溢れて捨てた件数の、前回からの増分を返す。
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
