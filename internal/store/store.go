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

// Message は購読者に配る新着。Name は SSE の event 名になる("sample" / "events")。
type Message struct {
	Name string
	Data any
}

// Store はホスト×プローブごとに直近 keep 件のサンプルと、ホストごとに直近 keepEvents 件のイベントを持つ。
type Store struct {
	mu         sync.RWMutex
	keep       int
	keepEvents int
	series     map[key][]model.Sample
	events     map[string][]model.ProcEvent
	lastSeen   map[string]time.Time
	subs       map[chan Message]string // 購読チャネル -> 絞り込むホスト("" なら全部)
}

func New(keep, keepEvents int) *Store {
	return &Store{
		keep:       keep,
		keepEvents: keepEvents,
		series:     map[key][]model.Sample{},
		events:     map[string][]model.ProcEvent{},
		lastSeen:   map[string]time.Time{},
		subs:       map[chan Message]string{},
	}
}

// Add はサンプルを追加し、購読者に配る。
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
	s.publish(x.Host, Message{"sample", x})
}

// AddEvents はイベントを追加し、購読者にまとめて配る。
func (s *Store) AddEvents(b model.EventBatch) {
	s.mu.Lock()
	defer s.mu.Unlock()

	buf := append(s.events[b.Host], b.Events...)
	if len(buf) > s.keepEvents {
		buf = slices.Clone(buf[len(buf)-s.keepEvents:])
	}
	s.events[b.Host] = buf
	s.publish(b.Host, Message{"events", b})
}

// Events は保持しているイベントのコピーを古い順に返す。
func (s *Store) Events(host string) []model.ProcEvent {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return orEmpty(slices.Clone(s.events[host]))
}

// publish は購読者に配る。詰まっている購読者には送らない(取りこぼしを許す)。呼び出し側でロックを持つ
func (s *Store) publish(host string, m Message) {
	for ch, h := range s.subs {
		if h != "" && h != host {
			continue
		}
		select {
		case ch <- m:
		default:
		}
	}
}

// Samples は保持している履歴のコピーを古い順に返す。
func (s *Store) Samples(host, probe string) []model.Sample {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return orEmpty(slices.Clone(s.series[key{host, probe}]))
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
func (s *Store) Subscribe(host string) (<-chan Message, func()) {
	ch := make(chan Message, 64)
	s.mu.Lock()
	s.subs[ch] = host
	s.mu.Unlock()
	return ch, func() {
		s.mu.Lock()
		delete(s.subs, ch)
		s.mu.Unlock()
	}
}

// orEmpty は nil を空スライスにする(JSON で null ではなく [] を返すため)。
func orEmpty[T any](xs []T) []T {
	if xs == nil {
		return []T{}
	}
	return xs
}
