// Package store はサンプルをメモリ上に保持し、新着を購読者に配る。
// 永続化(SQLite)は後の PR で足す。
package store

import (
	"slices"
	"sync"
	"time"

	"github.com/yoshiharu-ishii/ebpf-lens/internal/model"
)

type key struct{ host, probe string }

// Store はホスト×プローブごとに直近 keep 件のサンプルを持つ。
type Store struct {
	mu       sync.RWMutex
	keep     int
	series   map[key][]model.Sample
	lastSeen map[string]time.Time
	subs     map[chan model.Sample]string // 購読チャネル -> 絞り込むホスト("" なら全部)
}

func New(keep int) *Store {
	return &Store{
		keep:     keep,
		series:   map[key][]model.Sample{},
		lastSeen: map[string]time.Time{},
		subs:     map[chan model.Sample]string{},
	}
}

// Add はサンプルを追加し、購読者に配る。詰まっている購読者には送らない(取りこぼしを許す)。
func (s *Store) Add(x model.Sample) {
	s.mu.Lock()
	defer s.mu.Unlock()

	k := key{x.Host, x.Probe}
	buf := append(s.series[k], x)
	if len(buf) > s.keep {
		buf = slices.Clone(buf[len(buf)-s.keep:])
	}
	s.series[k] = buf
	s.lastSeen[x.Host] = x.Time

	for ch, host := range s.subs {
		if host != "" && host != x.Host {
			continue
		}
		select {
		case ch <- x:
		default:
		}
	}
}

// Samples は保持している履歴のコピーを古い順に返す。
func (s *Store) Samples(host, probe string) []model.Sample {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return slices.Clone(s.series[key{host, probe}])
}

// Hosts はホスト名順の一覧を返す。
func (s *Store) Hosts() []model.HostInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()

	probes := map[string][]string{}
	for k := range s.series {
		probes[k.host] = append(probes[k.host], k.probe)
	}
	out := make([]model.HostInfo, 0, len(s.lastSeen))
	for host, seen := range s.lastSeen {
		p := probes[host]
		slices.Sort(p)
		out = append(out, model.HostInfo{Name: host, LastSeen: seen, Probes: p})
	}
	slices.SortFunc(out, func(a, b model.HostInfo) int {
		if a.Name < b.Name {
			return -1
		}
		if a.Name > b.Name {
			return 1
		}
		return 0
	})
	return out
}

// Subscribe は新着サンプルを受け取るチャネルと、購読をやめる関数を返す。
func (s *Store) Subscribe(host string) (<-chan model.Sample, func()) {
	ch := make(chan model.Sample, 64)
	s.mu.Lock()
	s.subs[ch] = host
	s.mu.Unlock()
	return ch, func() {
		s.mu.Lock()
		delete(s.subs, ch)
		s.mu.Unlock()
	}
}
