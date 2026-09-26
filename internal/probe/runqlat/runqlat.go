// Package runqlat は run queue レイテンシ(起床から CPU に載るまで)の
// log2 ヒストグラムを eBPF で集める。
package runqlat

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -tags linux -cc clang -cflags "-O2 -g -Wall" -target amd64 runqlat runqlat.bpf.c -- -I../../../bpf/headers

import (
	"errors"
	"fmt"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"

	"github.com/yoshiharu-ishii/ebpf-lens/internal/model"
)

// MaxSlots は BPF 側の MAX_SLOTS と揃える。
// slot i は [2^i, 2^(i+1)) マイクロ秒(slot 0 のみ 0〜1µs)。
const MaxSlots = 27

// Probe は読み込み済みの BPF オブジェクトとアタッチ済みリンクを持つ。
type Probe struct {
	objs  runqlatObjects
	links []link.Link
	prev  [MaxSlots]uint64
}

// Open は BPF プログラムを読み込み、sched 系 tracepoint にアタッチする。
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

// Delta は前回呼び出しから今回までに増えた件数を slot ごとに返す。
// BPF 側は累積で数えているので、差分はユーザー空間で取る。
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

// Procs はプロセス別の集計を読み出して BPF マップから消し、名前ごとにまとめて返す。
// 読んでから消すまでの間に積まれた分は失われるが、1 区間に対してごく僅か。
func (p *Probe) Procs() ([]model.ProcStat, error) {
	var (
		key  runqlatProcKey
		val  runqlatProcVal
		keys []runqlatProcKey
	)
	byComm := map[string]*model.ProcStat{}
	it := p.objs.Procs.Iterate()
	for it.Next(&key, &val) {
		keys = append(keys, key)
		comm := commString(key.Comm)
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
		// 途中で終了したプロセスなどで既に無いことがあるので、エラーは無視する
		_ = p.objs.Procs.Delete(&keys[i])
	}

	out := make([]model.ProcStat, 0, len(byComm))
	for _, s := range byComm {
		out = append(out, *s)
	}
	return out, nil
}

const maxPids = 5

func commString(b [16]int8) string {
	n := 0
	for n < len(b) && b[n] != 0 {
		n++
	}
	s := make([]byte, n)
	for i := range n {
		s[i] = byte(b[i])
	}
	return string(s)
}

// Close はリンクを外して BPF オブジェクトを解放する。
func (p *Probe) Close() error {
	var errs []error
	for _, l := range p.links {
		errs = append(errs, l.Close())
	}
	errs = append(errs, p.objs.Close())
	return errors.Join(errs...)
}
