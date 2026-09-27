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
	SaveIncident(model.Incident)
}

// Observer sees every live sample and event batch after it is stored (the trigger evaluator is one).
// Observers are called outside the store lock and may call back into the store.
type Observer interface {
	OnSample(model.Sample)
	OnEvents(model.EventBatch)
}

// keepIncidents bounds the per-host incident list held in memory; the DB keeps the rest.
const keepIncidents = 500

// Store holds the latest keep samples per host × probe, the latest keepEvents events per host, and recent incidents.
// The in-memory data is the recent window for the UI; the Persister holds what is kept longer.
type Store struct {
	persist       Persister
	mu            sync.RWMutex
	keep          int
	keepEvents    int
	series        map[key][]model.Sample
	events        map[string][]model.ProcEvent
	incidents     map[string][]model.Incident
	lastSeen      map[string]time.Time
	subs          map[chan Message]string // subscriber channel -> host filter ("" means all hosts)
	observers     []Observer
	incidentHooks []func(model.Incident)
}

func New(keep, keepEvents int) *Store {
	return &Store{
		keep:       keep,
		keepEvents: keepEvents,
		series:     map[key][]model.Sample{},
		events:     map[string][]model.ProcEvent{},
		incidents:  map[string][]model.Incident{},
		lastSeen:   map[string]time.Time{},
		subs:       map[chan Message]string{},
	}
}

// AddObserver registers an Observer for live data (restored history is not replayed to it).
func (s *Store) AddObserver(o Observer) {
	s.mu.Lock()
	s.observers = append(s.observers, o)
	s.mu.Unlock()
}

// OnIncident registers a hook called for every live incident upsert (e.g. the webhook notifier).
func (s *Store) OnIncident(h func(model.Incident)) {
	s.mu.Lock()
	s.incidentHooks = append(s.incidentHooks, h)
	s.mu.Unlock()
}

// SetPersister sets the storage backend. Call it after restoring history with LoadInto (so the restored data is not written again).
func (s *Store) SetPersister(p Persister) {
	s.mu.Lock()
	s.persist = p
	s.mu.Unlock()
}

// Add adds a live sample: it is stored, persisted, delivered to subscribers, and judged by the observers.
func (s *Store) Add(x model.Sample) { s.add(x, true) }

// add stores a sample. live is false when restoring history: nothing is persisted again or re-judged.
func (s *Store) add(x model.Sample, live bool) {
	s.mu.Lock()
	k := key{x.Host, x.Probe}
	buf := append(s.series[k], x)
	if len(buf) > s.keep {
		buf = slices.Clone(buf[len(buf)-s.keep:])
	}
	s.series[k] = buf
	if x.Time.After(s.lastSeen[x.Host]) {
		s.lastSeen[x.Host] = x.Time
	}
	if live && s.persist != nil {
		s.persist.SaveSample(x)
	}
	s.publish(x.Host, Message{"sample", x})
	obs := s.observers
	s.mu.Unlock()

	if live {
		for _, o := range obs {
			o.OnSample(x)
		}
	}
}

// AddEvents adds a live batch of events: stored, persisted, delivered to subscribers, and judged by the observers.
func (s *Store) AddEvents(b model.EventBatch) { s.addEvents(b, true) }

func (s *Store) addEvents(b model.EventBatch, live bool) {
	s.mu.Lock()
	buf := append(s.events[b.Host], b.Events...)
	if len(buf) > s.keepEvents {
		buf = slices.Clone(buf[len(buf)-s.keepEvents:])
	}
	s.events[b.Host] = buf
	if live && s.persist != nil {
		s.persist.SaveEvents(b)
	}
	s.publish(b.Host, Message{"events", b})
	obs := s.observers
	s.mu.Unlock()

	if live {
		for _, o := range obs {
			o.OnEvents(b)
		}
	}
}

// AddIncident inserts or replaces an incident by ID, persists it, streams it to subscribers, and runs the hooks.
func (s *Store) AddIncident(inc model.Incident) { s.addIncident(inc, true) }

func (s *Store) addIncident(inc model.Incident, live bool) {
	s.mu.Lock()
	buf := s.incidents[inc.Host]
	if i := slices.IndexFunc(buf, func(x model.Incident) bool { return x.ID == inc.ID }); i >= 0 {
		buf[i] = inc
	} else {
		buf = append(buf, inc)
		if len(buf) > keepIncidents {
			buf = slices.Clone(buf[len(buf)-keepIncidents:])
		}
	}
	s.incidents[inc.Host] = buf
	if live && s.persist != nil {
		s.persist.SaveIncident(inc)
	}
	s.publish(inc.Host, Message{"incident", inc})
	hooks := s.incidentHooks
	s.mu.Unlock()

	if live {
		for _, h := range hooks {
			h(inc)
		}
	}
}

// Incidents returns a copy of the stored incidents for a host, oldest first.
func (s *Store) Incidents(host string) []model.Incident {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return orEmpty(slices.Clone(s.incidents[host]))
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
