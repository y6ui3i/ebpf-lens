// Package runqlat は run queue レイテンシ(起床から CPU に載るまで)の
// log2 ヒストグラムを eBPF で集める。
package runqlat

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -tags linux -cc clang -cflags "-O2 -g -Wall" -target amd64 runqlat runqlat.bpf.c -- -I../../../bpf/headers

import (
	"errors"
	"fmt"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"
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

// Close はリンクを外して BPF オブジェクトを解放する。
func (p *Probe) Close() error {
	var errs []error
	for _, l := range p.links {
		errs = append(errs, l.Close())
	}
	errs = append(errs, p.objs.Close())
	return errors.Join(errs...)
}
