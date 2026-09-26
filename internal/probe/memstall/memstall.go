// Package memstall はメモリ回収(direct reclaim / memcg reclaim)で止まった時間を eBPF で測る。
package memstall

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -tags linux -cc clang -cflags "-O2 -g -Wall" -target amd64 memstall memstall.bpf.c -- -I../../../bpf/headers

import (
	"errors"
	"fmt"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"

	"github.com/yoshiharu-ishii/ebpf-lens/internal/model"
	"github.com/yoshiharu-ishii/ebpf-lens/internal/probe"
)

// MaxSlots は BPF 側の MAX_SLOTS と揃える。slot i は [2^i, 2^(i+1)) マイクロ秒。
const MaxSlots = 27

const maxPids = 5

type Probe struct {
	objs  memstallObjects
	links []link.Link
	prev  [MaxSlots]uint64
}

// Open は BPF プログラムを読み込み、vmscan の tracepoint にアタッチする。
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

// Delta は前回から今回までに増えた停止回数を slot ごとに返す。
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

// Procs はプロセス別の集計を読み出して消し、名前ごとにまとめて返す。
// runqlat と同じ ProcStat を使い、Wait* を「回収で止まった」の意味で使う。
func (p *Probe) Procs() ([]model.ProcStat, error) {
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
