package trigger

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/yoshiharu-ishii/ebpf-lens/internal/model"
)

// Incident kinds and levels. Kept as plain strings because they travel as JSON to the UI and to webhooks.
const (
	KindCPUWait   = "cpu_wait"
	KindMemStall  = "mem_stall"
	KindOOMKill   = "oom_kill"
	KindCrash     = "crash"
	KindCrashLoop = "crash_loop"
	KindAgentDown = "agent_down"

	LevelCaution = "caution"
	LevelWarning = "warning"
)

// Signals treated as a crash. SIGTERM / SIGKILL / SIGINT are normal ways to stop a process and are not crashes.
var crashSignals = map[int]bool{4: true, 6: true, 7: true, 8: true, 11: true, 31: true}

// Sink receives every new or changed incident. The store implements it.
type Sink interface {
	AddIncident(model.Incident)
}

// Evaluator holds the rule state per host. It is fed by the store (OnSample / OnEvents) and by a clock (Tick).
type Evaluator struct {
	cfg  Config
	sink Sink
	mu   sync.Mutex
	host map[string]*hostState
}

type hostState struct {
	cpu, mem  excursion
	crashes   map[string][]time.Time     // command -> recent crash times, oldest first
	crashLoop map[string]*model.Incident // open crash-loop incidents by command
	lastSeen  time.Time
	down      *model.Incident
}

// excursion tracks one value that may be above its threshold. It exists before the incident opens
// (the first MinSeconds) and lingers after the value drops (the MaxGapSeconds grace period).
type excursion struct {
	active      bool
	first, last time.Time
	seconds     int
	warnSeconds int
	peak        float64
	open        *model.Incident
	lastUpsert  time.Time
}

func New(cfg Config, sink Sink) *Evaluator {
	return &Evaluator{cfg: cfg, sink: sink, host: map[string]*hostState{}}
}

func (e *Evaluator) state(host string) *hostState {
	h := e.host[host]
	if h == nil {
		h = &hostState{crashes: map[string][]time.Time{}, crashLoop: map[string]*model.Incident{}}
		e.host[host] = h
	}
	return h
}

// OnSample judges one sample. Only the probes it knows are looked at; others just count as "the host is alive".
func (e *Evaluator) OnSample(x model.Sample) {
	e.mu.Lock()
	defer e.mu.Unlock()
	h := e.state(x.Host)
	e.seen(h, x.Host, x.Time)
	switch x.Probe {
	case "runqlat":
		if p99, ok := Percentile(x.Slots, 0.99); ok {
			e.judge(&h.cpu, x.Host, KindCPUWait, e.cfg.CPU, p99, x.Time)
		}
	case "memstall":
		if x.Mem != nil && x.IntervalMs > 0 {
			msPerSec := float64(x.Mem.StallNs) / 1e6 / (float64(x.IntervalMs) / 1000)
			e.judge(&h.mem, x.Host, KindMemStall, e.cfg.Memory, msPerSec, x.Time)
		}
	}
}

// OnEvents judges process events: OOM kills and crashes are instant incidents; repeated crashes become a loop.
func (e *Evaluator) OnEvents(b model.EventBatch) {
	e.mu.Lock()
	defer e.mu.Unlock()
	h := e.state(b.Host)
	if !b.Time.IsZero() {
		e.seen(h, b.Host, b.Time)
	}
	for _, ev := range b.Events {
		switch {
		case ev.Kind == "oom":
			e.sink.AddIncident(instant(b.Host, KindOOMKill, LevelWarning, ev, func(i *model.Incident) {
				i.Memcg, i.TriggerComm, i.TriggerPid = ev.Memcg, ev.TriggerComm, ev.TriggerPid
			}))
		case ev.Kind == "exit" && (crashSignals[ev.Signal] || ev.CoreDump):
			e.sink.AddIncident(instant(b.Host, KindCrash, LevelCaution, ev, func(i *model.Incident) {
				i.Signal, i.CoreDump = ev.Signal, ev.CoreDump
			}))
			e.crashLoopStep(h, b.Host, ev)
		}
	}
}

// MarkSeen records when a host last reported without judging anything. main calls it for each host restored
// from the DB, so a host that is still silent after a server restart is flagged instead of forgotten.
func (e *Evaluator) MarkSeen(host string, t time.Time) {
	e.mu.Lock()
	defer e.mu.Unlock()
	h := e.state(host)
	if t.After(h.lastSeen) {
		h.lastSeen = t
	}
}

// Tick advances time-based state: excursions that ended because samples stopped, crash loops that went quiet,
// and hosts that stopped reporting. Run calls it every second; tests call it directly.
func (e *Evaluator) Tick(now time.Time) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for host, h := range e.host {
		e.closeIfQuiet(&h.cpu, e.cfg.CPU, now)
		e.closeIfQuiet(&h.mem, e.cfg.Memory, now)
		e.crashLoopTick(h, now)
		e.agentDownTick(h, host, now)
	}
}

// Run calls Tick every second until ctx is done.
func (e *Evaluator) Run(ctx context.Context) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			e.Tick(now)
		}
	}
}

// --- excursions (cpu_wait, mem_stall) ---

func (e *Evaluator) judge(x *excursion, host, kind string, r ExcursionRule, v float64, t time.Time) {
	gap := time.Duration(r.MaxGapSeconds) * time.Second
	if v < r.Caution {
		// Below the threshold. Close the excursion only once the grace period has passed
		if x.active && t.Sub(x.last) > gap {
			e.closeExcursion(x)
		}
		return
	}
	if x.active && t.Sub(x.last) > gap {
		// The previous excursion ended while no sample below the threshold arrived (e.g. a pause in reporting)
		e.closeExcursion(x)
	}
	if !x.active {
		*x = excursion{active: true, first: t}
	}
	x.last = t
	x.seconds++
	x.peak = max(x.peak, v)
	if v >= r.Warning {
		x.warnSeconds++
	}
	level := LevelCaution
	if x.warnSeconds >= r.MinSeconds {
		level = LevelWarning
	}
	switch {
	case x.open == nil && x.seconds >= r.MinSeconds:
		x.open = &model.Incident{
			ID: incidentID(host, kind, "", x.first), Host: host, Kind: kind, Level: level,
			Start: x.first, Updated: t, Seconds: x.seconds, Peak: x.peak,
		}
		x.lastUpsert = t
		e.sink.AddIncident(*x.open)
	case x.open != nil:
		escalate := level == LevelWarning && x.open.Level != LevelWarning
		x.open.Seconds, x.open.Peak, x.open.Updated = x.seconds, x.peak, t
		if escalate {
			x.open.Level = LevelWarning // never downgrade while open; the peak tells the story
		}
		// Publish progress every few seconds rather than every second; changes of level go out at once
		if escalate || t.Sub(x.lastUpsert) >= 5*time.Second {
			x.lastUpsert = t
			e.sink.AddIncident(*x.open)
		}
	}
}

func (e *Evaluator) closeIfQuiet(x *excursion, r ExcursionRule, now time.Time) {
	// A bit more slack than the sample-driven path, since samples normally arrive once a second
	if x.active && now.Sub(x.last) > time.Duration(r.MaxGapSeconds+2)*time.Second {
		e.closeExcursion(x)
	}
}

func (e *Evaluator) closeExcursion(x *excursion) {
	if x.open != nil {
		end := x.last
		x.open.End, x.open.Seconds, x.open.Peak, x.open.Updated = &end, x.seconds, x.peak, end
		e.sink.AddIncident(*x.open)
	}
	*x = excursion{}
}

// --- crash loops ---

func (e *Evaluator) crashLoopStep(h *hostState, host string, ev model.ProcEvent) {
	window := time.Duration(e.cfg.Processes.CrashLoopWindowSeconds) * time.Second
	times := append(h.crashes[ev.Comm], ev.Time)
	for len(times) > 0 && ev.Time.Sub(times[0]) > window {
		times = times[1:]
	}
	h.crashes[ev.Comm] = times
	if len(times) < e.cfg.Processes.CrashLoopCount {
		return
	}
	inc := h.crashLoop[ev.Comm]
	if inc == nil {
		inc = &model.Incident{
			ID: incidentID(host, KindCrashLoop, ev.Comm, times[0]), Host: host, Kind: KindCrashLoop,
			Level: LevelWarning, Subject: ev.Comm, Start: times[0],
		}
		h.crashLoop[ev.Comm] = inc
	}
	inc.Count, inc.Peak, inc.Updated = len(times), float64(len(times)), ev.Time
	e.sink.AddIncident(*inc)
}

func (e *Evaluator) crashLoopTick(h *hostState, now time.Time) {
	window := time.Duration(e.cfg.Processes.CrashLoopWindowSeconds) * time.Second
	for comm, inc := range h.crashLoop {
		if now.Sub(inc.Updated) > window {
			end := inc.Updated
			inc.End = &end
			e.sink.AddIncident(*inc)
			delete(h.crashLoop, comm)
			delete(h.crashes, comm)
		}
	}
}

// --- agent down ---

func (e *Evaluator) seen(h *hostState, host string, t time.Time) {
	if t.After(h.lastSeen) {
		h.lastSeen = t
	}
	if h.down != nil {
		// The host is back: close the incident at the time it came back
		end := t
		h.down.End, h.down.Updated = &end, t
		h.down.Seconds = int(t.Sub(h.down.Start) / time.Second)
		e.sink.AddIncident(*h.down)
		h.down = nil
	}
}

func (e *Evaluator) agentDownTick(h *hostState, host string, now time.Time) {
	if h.lastSeen.IsZero() {
		return
	}
	silent := now.Sub(h.lastSeen)
	after := time.Duration(e.cfg.AgentDown.AfterSeconds) * time.Second
	switch {
	case h.down == nil && silent > after:
		h.down = &model.Incident{
			ID: incidentID(host, KindAgentDown, "", h.lastSeen), Host: host, Kind: KindAgentDown,
			Level: LevelWarning, Start: h.lastSeen, Updated: now, Seconds: int(silent / time.Second),
		}
		e.sink.AddIncident(*h.down)
	case h.down != nil && now.Sub(h.down.Updated) >= 30*time.Second:
		h.down.Seconds, h.down.Updated = int(silent/time.Second), now
		e.sink.AddIncident(*h.down)
	}
}

// --- helpers ---

func instant(host, kind, level string, ev model.ProcEvent, fill func(*model.Incident)) model.Incident {
	t := ev.Time
	inc := model.Incident{
		ID: incidentID(host, kind, fmt.Sprint(ev.Pid), t), Host: host, Kind: kind, Level: level,
		Subject: ev.Comm, Pid: ev.Pid, Start: t, End: &t, Updated: t,
	}
	fill(&inc)
	return inc
}

func incidentID(host, kind, subject string, start time.Time) string {
	return fmt.Sprintf("%s|%s|%s|%d", host, kind, subject, start.UnixMilli())
}

// Percentile estimates a percentile from a log2 histogram (slot i covers [2^i, 2^(i+1)) µs, slot 0 is [0, 2)),
// interpolating linearly inside the slot. Being read off a histogram, it can be off by up to 2x.
// It mirrors percentile() in frontend/src/lib/hist.ts so the UI and the server agree.
func Percentile(slots []uint64, q float64) (float64, bool) {
	var n uint64
	for _, c := range slots {
		n += c
	}
	if n == 0 {
		return 0, false
	}
	target := q * float64(n)
	var cum float64
	for i, c := range slots {
		if c > 0 && cum+float64(c) >= target {
			lo, hi := slotRange(i)
			return max(1, lo+(hi-lo)*(target-cum)/float64(c)), true
		}
		cum += float64(c)
	}
	_, hi := slotRange(len(slots) - 1)
	return hi, true
}

func slotRange(i int) (lo, hi float64) {
	if i == 0 {
		return 0, 2
	}
	return float64(uint64(1) << i), float64(uint64(1) << (i + 1))
}

// SortIncidents orders incidents newest first (ongoing ones before closed ones that started at the same time).
func SortIncidents(xs []model.Incident) {
	sort.SliceStable(xs, func(i, j int) bool {
		if !xs[i].Start.Equal(xs[j].Start) {
			return xs[i].Start.After(xs[j].Start)
		}
		return xs[i].Ongoing() && !xs[j].Ongoing()
	})
}
