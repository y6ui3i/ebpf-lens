// Package store keeps samples and events in memory and delivers new data to subscribers.
// Persistence is delegated to a Persister (SQLite for now; swap in PostgreSQL once it grows).
package store

import (
	"slices"
	"sync"
	"time"

	"github.com/yoshiharu-ishii/ebpf-lens/internal/model"
)

type key struct{ host, probe string }

// Message is new data delivered to subscribers. Name becomes the SSE event name ("sample" / "events").
type Message struct {
	Name string
	Data any
}

// Persister is the storage backend. Store depends only on this interface. Implementations must write asynchronously so ingestion is never blocked.
type Persister interface {
	SaveSample(model.Sample)
	SaveEvents(model.EventBatch)
}

// Store holds the latest keep samples per host × probe and the latest keepEvents events per host.
// The in-memory data is the recent window for the UI; the Persister holds what is kept longer.
type Store struct {
	persist    Persister
	mu         sync.RWMutex
	keep       int
	keepEvents int
	series     map[key][]model.Sample
	events     map[string][]model.ProcEvent
	lastSeen   map[string]time.Time
	subs       map[chan Message]string // subscriber channel -> host filter ("" means all hosts)
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

// SetPersister sets the storage backend. Call it after restoring history with LoadInto (so the restored data is not written again).
func (s *Store) SetPersister(p Persister) {
	s.mu.Lock()
	s.persist = p
	s.mu.Unlock()
}

// Add adds a sample, persists it, and delivers it to subscribers.
func (s *Store) Add(x model.Sample) { s.add(x, true) }

func (s *Store) add(x model.Sample, save bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	k := key{x.Host, x.Probe}
	buf := append(s.series[k], x)
	if len(buf) > s.keep {
		buf = slices.Clone(buf[len(buf)-s.keep:])
	}
	s.series[k] = buf
	if x.Time.After(s.lastSeen[x.Host]) {
		s.lastSeen[x.Host] = x.Time
	}
	if save && s.persist != nil {
		s.persist.SaveSample(x)
	}
	s.publish(x.Host, Message{"sample", x})
}

// AddEvents adds events, persists them, and delivers them to subscribers as one batch.
func (s *Store) AddEvents(b model.EventBatch) { s.addEvents(b, true) }

func (s *Store) addEvents(b model.EventBatch, save bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	buf := append(s.events[b.Host], b.Events...)
	if len(buf) > s.keepEvents {
		buf = slices.Clone(buf[len(buf)-s.keepEvents:])
	}
	s.events[b.Host] = buf
	if save && s.persist != nil {
		s.persist.SaveEvents(b)
	}
	s.publish(b.Host, Message{"events", b})
}

// Events returns a copy of the stored events, oldest first.
func (s *Store) Events(host string) []model.ProcEvent {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return orEmpty(slices.Clone(s.events[host]))
}

// publish delivers to subscribers. Subscribers that are backed up are skipped (dropping is allowed). The caller must hold the lock
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

// Samples returns a copy of the stored history, oldest first.
func (s *Store) Samples(host, probe string) []model.Sample {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return orEmpty(slices.Clone(s.series[key{host, probe}]))
}

// Hosts returns the list of hosts sorted by name.
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

// Subscribe returns a channel that receives new samples and a function that cancels the subscription.
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

// orEmpty turns nil into an empty slice (so JSON returns [] instead of null).
func orEmpty[T any](xs []T) []T {
	if xs == nil {
		return []T{}
	}
	return xs
}
