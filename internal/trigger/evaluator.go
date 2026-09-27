package trigger

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/yoshiharu-ishii/ebpf-lens/internal/model"
)

// Incident kinds and levels. Kept as plain strings because they travel as JSON to the UI and to webhooks.
const (
	KindCPUWait        = "cpu_wait"
	KindMemStall       = "mem_stall"
	KindOOMKill        = "oom_kill"
	KindCrash          = "crash"
	KindCrashLoop      = "crash_loop"
	KindAgentDown      = "agent_down"
	KindVMDown         = "vm_down"
	KindVMCPUWait      = "vm_cpu_wait"
	KindGPUStarved     = "gpu_starved" // the GPU sat idle while a CUDA process was busy on the CPU or copying
	KindVRAMFull       = "vram_full"
	KindDiskSlow       = "disk_slow"        // block I/O latency p99 above threshold; names who issued the I/O
	KindDiskError      = "disk_error"       // a block device completed I/O with an error
	KindNetConnectFail = "net_connect_fail" // outbound TCP connects failing (refused / unreachable / timed out)
	KindNetConnectSlow = "net_connect_slow" // connect latency p99 high: at 1 s the SYN itself is being retransmitted
	KindNetRetrans     = "net_retrans"      // TCP segments retransmitted (packet loss or a congested path)

	CauseHostOOM   = "host_oom"
	CauseCgroupOOM = "cgroup_oom"
	CauseCrash     = "crash"
	CauseKilled    = "killed"
	CauseShutdown  = "shutdown"

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
	cfg     Config
	sink    Sink
	history History
	mu      sync.Mutex
	host    map[string]*hostState
}

// History gives the rules access to recent samples, for the context an incident is judged in
// (what a VM went through in the minute before it died). The store implements it; nil disables context.
type History interface {
	Samples(host, probe string) []model.Sample
}

type hostState struct {
	cpu, mem                     excursion
	crashes                      map[string][]time.Time     // command -> recent crash times, oldest first
	crashLoop                    map[string]*model.Incident // open crash-loop incidents by command
	lastSeen                     time.Time
	down                         *model.Incident
	ooms                         map[uint32]model.ProcEvent // pid -> OOM kill seen recently, matched to the exit that follows
	signals                      map[uint32]model.ProcEvent // pid -> last terminating signal sent to it, matched to the exit that follows
	vmcpu                        map[string]*excursion      // VM name -> its own run-queue wait excursion (host side)
	gpu, vram                    excursion
	gpuLast                      gpuStarve // what the latest gpu sample said, copied onto the incident whenever it is published
	disk                         excursion
	netFail, netSlow, netRetrans excursion
	failRing                     [failWindow]uint64 // failed connects per second, last failWindow seconds (a burst of refused connects is an incident even if it lasts one second)
	failRingSec                  int64
}

// failWindow is how many seconds of failed connects net_connect_fail sums over.
const failWindow = 10

// gpuStarve is the process that was starving the GPU in the latest sample, and how.
type gpuStarve struct {
	comm                             string
	util, cpuShare, copyShare, score float64
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

// SetHistory enables context lookups (see History).
func (e *Evaluator) SetHistory(h History) { e.history = h }

func (e *Evaluator) state(host string) *hostState {
	h := e.host[host]
	if h == nil {
		h = &hostState{crashes: map[string][]time.Time{}, crashLoop: map[string]*model.Incident{}, ooms: map[uint32]model.ProcEvent{}, signals: map[uint32]model.ProcEvent{}, vmcpu: map[string]*excursion{}}
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
			e.judge(&h.cpu, x.Host, KindCPUWait, "", e.cfg.CPU, p99, x.Time, e.culpritDecorator(x.Host, ""))
		}
		// Each VM's own host-side wait is judged with the same thresholds; its culprits exclude the VM itself
		for _, p := range x.Procs {
			name, ok := strings.CutPrefix(p.Comm, "vm:")
			if !ok {
				continue
			}
			p99, ok := Percentile(p.Slots, 0.99)
			if !ok {
				continue
			}
			ex := h.vmcpu[name]
			if ex == nil {
				ex = &excursion{}
				h.vmcpu[name] = ex
			}
			e.judge(ex, x.Host, KindVMCPUWait, name, e.cfg.CPU, p99, x.Time, e.culpritDecorator(x.Host, p.Comm))
		}
	case "memstall":
		if x.Mem != nil && x.IntervalMs > 0 {
			msPerSec := float64(x.Mem.StallNs) / 1e6 / (float64(x.IntervalMs) / 1000)
			e.judge(&h.mem, x.Host, KindMemStall, "", e.cfg.Memory, msPerSec, x.Time, nil)
		}
	case "biolat":
		if p99, ok := Percentile(x.Slots, 0.99); ok {
			e.judge(&h.disk, x.Host, KindDiskSlow, "", e.cfg.Disk, p99, x.Time, e.ioCulpritDecorator(x.Host))
		}
		if x.Disk != nil {
			for _, d := range x.Disk.Devices {
				if d.Errors == 0 {
					continue
				}
				e.sink.AddIncident(model.Incident{
					ID: incidentID(x.Host, KindDiskError, d.Name, x.Time), Host: x.Host, Kind: KindDiskError, Level: LevelWarning,
					Subject: d.Name, Device: d.Name, Start: x.Time, End: &x.Time, Updated: x.Time, Count: int(d.Errors),
				})
			}
		}
	case "tcpconn":
		if x.Net == nil || x.IntervalMs <= 0 {
			return
		}
		sec := float64(x.IntervalMs) / 1000
		var fails, retrans uint64
		for _, d := range x.Net.Dests {
			fails += d.Fails
			retrans += d.Retrans
		}
		e.judge(&h.netFail, x.Host, KindNetConnectFail, "", e.cfg.Network.ConnectFails, float64(h.failsInWindow(x.Time, fails)), x.Time, e.destDecorator(x.Host, "fails"))
		e.judge(&h.netRetrans, x.Host, KindNetRetrans, "", e.cfg.Network.Retrans, float64(retrans)/sec, x.Time, e.destDecorator(x.Host, "retrans"))
		if p99, ok := Percentile(x.Slots, 0.99); ok {
			e.judge(&h.netSlow, x.Host, KindNetConnectSlow, "", e.cfg.Network.ConnectLatency, p99, x.Time, e.destDecorator(x.Host, "slow"))
		}
	case "gpu":
		if x.GPU == nil || x.IntervalMs <= 0 {
			return
		}
		h.gpuLast = starving(*x.GPU, x.IntervalMs, e.cfg.GPU.IdleUtil)
		e.judge(&h.gpu, x.Host, KindGPUStarved, h.gpuLast.comm, e.cfg.GPU.Starved, h.gpuLast.score, x.Time, h.gpuDecorator())
		if x.GPU.TotalBytes > 0 {
			e.judge(&h.vram, x.Host, KindVRAMFull, "", e.cfg.GPU.VRAM, float64(x.GPU.UsedBytes)/float64(x.GPU.TotalBytes), x.Time, nil)
		}
	}
}

// --- why is the GPU idle ---

// starving finds the CUDA process that is working hardest while the GPU sits below idleUtil: the score is the
// share of the interval it spent on the CPU or inside copy calls (whichever is larger; a copy from pageable memory
// is CPU work too), capped at 1. When the GPU is busy enough the score is 0, whatever the processes do.
func starving(g model.GPUStat, intervalMs int64, idleUtil float64) gpuStarve {
	best := gpuStarve{util: g.Util}
	if g.Util >= idleUtil {
		return best
	}
	interval := float64(intervalMs) * 1e6
	for _, p := range g.Procs {
		cpu := min(1, float64(p.OnCPUNs)/interval)
		cp := min(1, float64(p.CopyNs)/interval)
		if s := max(cpu, cp); s > best.score {
			best = gpuStarve{comm: p.Comm, util: g.Util, cpuShare: cpu, copyShare: cp, score: s}
		}
	}
	return best
}

// gpuDecorator copies the latest starving process onto the incident. The incident keeps the subject it opened
// with in its ID; the fields say who is starving the GPU now.
func (h *hostState) gpuDecorator() func(*model.Incident) {
	return func(i *model.Incident) {
		s := h.gpuLast
		if s.comm == "" {
			return // closing after the GPU got busy: keep the last known culprit
		}
		i.Subject, i.GPUUtil, i.CPUShare, i.CopyShare = s.comm, s.util, s.cpuShare, s.copyShare
	}
}

// failsInWindow adds this second's failed connects to the ring and returns the total over the last failWindow seconds.
func (h *hostState) failsInWindow(t time.Time, fails uint64) uint64 {
	sec := t.Unix()
	if h.failRingSec == 0 || sec-h.failRingSec >= failWindow {
		h.failRing = [failWindow]uint64{}
	} else {
		for s := h.failRingSec + 1; s <= sec; s++ {
			h.failRing[s%failWindow] = 0 // seconds that passed without a sample
		}
	}
	h.failRingSec = sec
	h.failRing[sec%failWindow] += fails
	var sum uint64
	for _, v := range h.failRing {
		sum += v
	}
	return sum
}

// --- which destinations ---

// destCulprits applies the culprit grouping rule to destinations over the tcpconn samples of [from, to]:
// by their share of failed connects ("fails"), of retransmitted segments ("retrans"), or of connect latency
// ("slow": total latency, so a destination with many slow connects outranks one slow connect).
func (e *Evaluator) destCulprits(host string, from, to time.Time, by string) ([]model.Culprit, float64) {
	if e.history == nil {
		return nil, 0
	}
	shares := map[string]float64{}
	var all float64
	for _, s := range e.history.Samples(host, "tcpconn") {
		if s.Time.Before(from) || s.Time.After(to) || s.Net == nil {
			continue
		}
		for _, d := range s.Net.Dests {
			var v float64
			switch by {
			case "fails":
				v = float64(d.Fails)
			case "retrans":
				v = float64(d.Retrans)
			default:
				v = float64(d.LatNs)
			}
			if v == 0 {
				continue
			}
			name := fmt.Sprintf("%s:%d", d.Addr, d.Port)
			if d.Port == 0 {
				name = fmt.Sprintf("clients at %s", d.Addr) // retransmits on connections into this host
			}
			shares[name] += v
			all += v
		}
	}
	if all == 0 {
		return nil, 0
	}
	for k, v := range shares {
		shares[k] = v / all
	}
	return GroupCulprits(shares)
}

func (e *Evaluator) destDecorator(host, by string) func(*model.Incident) {
	return func(i *model.Incident) {
		end := i.Updated
		if i.End != nil {
			end = *i.End
		}
		i.Culprits, i.CulpritShare = e.destCulprits(host, i.Start, end, by)
	}
}

// --- who issued the I/O ---

// ioCulprits applies the culprit grouping rule to bytes issued per process in the biolat samples of [from, to]:
// shares are of all bytes moved in the window. Buffered writes are issued by kernel writeback threads
// (kworker), so those show up as the issuer rather than the process that wrote.
func (e *Evaluator) ioCulprits(host string, from, to time.Time) ([]model.Culprit, float64) {
	if e.history == nil {
		return nil, 0
	}
	shares := map[string]float64{}
	var all float64
	for _, s := range e.history.Samples(host, "biolat") {
		if s.Time.Before(from) || s.Time.After(to) {
			continue
		}
		for _, p := range s.Procs {
			b := float64(p.ReadBytes + p.WriteBytes)
			shares[p.Comm] += b
			all += b
		}
	}
	if all == 0 {
		return nil, 0
	}
	for k, v := range shares {
		shares[k] = v / all
	}
	return GroupCulprits(shares)
}

func (e *Evaluator) ioCulpritDecorator(host string) func(*model.Incident) {
	return func(i *model.Incident) {
		end := i.Updated
		if i.End != nil {
			end = *i.End
		}
		i.Culprits, i.CulpritShare = e.ioCulprits(host, i.Start, end)
	}
}

// --- who took the CPU ---

// Culprit grouping: consumers with at least culpritMinShare of the host, largest first, at most culpritMax of them,
// and only if together they used at least culpritTotalShare. One hog at 99 % is a group of one; three VMs at
// 34/24/23 % are a group of three; ten processes at 7 % each are no group at all (the CPU is simply shared).
const (
	culpritMinShare   = 0.10
	culpritTotalShare = 0.50
	culpritMax        = 5
)

// GroupCulprits applies the grouping rule to per-name CPU shares (fractions of the host's capacity).
// It returns the group (largest first) and its combined share; an empty group means no one stands out.
func GroupCulprits(shares map[string]float64) ([]model.Culprit, float64) {
	var xs []model.Culprit
	for name, sh := range shares {
		if sh >= culpritMinShare {
			xs = append(xs, model.Culprit{Name: name, Share: sh})
		}
	}
	sort.Slice(xs, func(i, j int) bool {
		if xs[i].Share != xs[j].Share {
			return xs[i].Share > xs[j].Share
		}
		return xs[i].Name < xs[j].Name
	})
	if len(xs) > culpritMax {
		xs = xs[:culpritMax]
	}
	var total float64
	for _, c := range xs {
		total += c.Share
	}
	if total < culpritTotalShare {
		return nil, 0
	}
	return xs, total
}

// culprits computes the culprit group from the runqlat samples in [from, to], leaving out `exclude`
// (the waiting VM itself), plus how busy the host was over the same window.
func (e *Evaluator) culprits(host string, from, to time.Time, exclude string) (group []model.Culprit, total, busy float64) {
	if e.history == nil {
		return nil, 0, 0
	}
	shares := map[string]float64{}
	var on, busyNs, cap float64
	for _, s := range e.history.Samples(host, "runqlat") {
		if s.Time.Before(from) || s.Time.After(to) || s.IntervalMs <= 0 || s.CPUs <= 0 {
			continue
		}
		cap += float64(s.IntervalMs) * 1e6 * float64(s.CPUs)
		busyNs += float64(s.BusyNs)
		for _, p := range s.Procs {
			if p.Comm == exclude {
				continue
			}
			shares[p.Comm] += float64(p.OnCPUNs)
			on += float64(p.OnCPUNs)
		}
	}
	_ = on
	if cap == 0 {
		return nil, 0, 0
	}
	for k, v := range shares {
		shares[k] = v / cap
	}
	group, total = GroupCulprits(shares)
	return group, total, busyNs / cap
}

// culpritDecorator attaches the culprit group for the incident's own window (start .. last update).
func (e *Evaluator) culpritDecorator(host, exclude string) func(*model.Incident) {
	return func(i *model.Incident) {
		end := i.Updated
		if i.End != nil {
			end = *i.End
		}
		i.Culprits, i.CulpritShare, i.HostBusy = e.culprits(host, i.Start, end.Add(time.Second), exclude)
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
			h.ooms[ev.Pid] = ev // the exit of the killed process arrives right after; vm_down uses this to name the cause
			e.sink.AddIncident(instant(b.Host, KindOOMKill, LevelWarning, ev, func(i *model.Incident) {
				i.Memcg, i.TriggerComm, i.TriggerPid, i.VM = ev.Memcg, ev.TriggerComm, ev.TriggerPid, ev.VM
			}))
		case ev.Kind == "signal":
			h.signals[ev.Pid] = ev
		case ev.Kind == "exit" && ev.VM != "":
			e.vmDown(h, b.Host, ev)
		case ev.Kind == "exit" && (crashSignals[ev.Signal] || ev.CoreDump):
			e.sink.AddIncident(instant(b.Host, KindCrash, LevelCaution, ev, func(i *model.Incident) {
				i.Signal, i.CoreDump = ev.Signal, ev.CoreDump
			}))
			e.crashLoopStep(h, b.Host, ev)
		}
	}
	// OOM and signal records only matter for the exit that follows within seconds
	for pid, o := range h.ooms {
		if b.Time.Sub(o.Time) > 30*time.Second {
			delete(h.ooms, pid)
		}
	}
	for pid, o := range h.signals {
		if b.Time.Sub(o.Time) > 30*time.Second {
			delete(h.signals, pid)
		}
	}
}

// --- vm_down ---

// vmDown explains why a VM's QEMU process stopped, from the evidence at hand: an OOM kill just before (and whether
// it was the host or the VM's own cgroup that ran out), a crash signal, a deliberate kill, or a clean exit.
func (e *Evaluator) vmDown(h *hostState, host string, ev model.ProcEvent) {
	level := LevelCaution
	cause := CauseShutdown
	oom, hadOOM := h.ooms[ev.Pid]
	sig, hadSig := h.signals[ev.Pid] // QEMU handles SIGTERM and exits 0, so the exit alone cannot show a kill
	switch {
	case hadOOM && oom.Memcg:
		cause, level = CauseCgroupOOM, LevelWarning
	case hadOOM:
		cause, level = CauseHostOOM, LevelWarning
	case crashSignals[ev.Signal] || ev.CoreDump:
		cause, level = CauseCrash, LevelWarning
	case ev.Signal != 0 || hadSig:
		cause = CauseKilled // libvirt destroy, an administrator, or a supervisor; Trigger* says who
	}
	delete(h.ooms, ev.Pid)
	delete(h.signals, ev.Pid)
	inc := instant(host, KindVMDown, level, ev, func(i *model.Incident) {
		i.Subject, i.VM, i.Cause = ev.VM, ev.VM, cause
		i.Signal, i.CoreDump, i.ExitStatus = ev.Signal, ev.CoreDump, ev.ExitStatus
		switch {
		case hadOOM:
			i.Memcg, i.TriggerComm, i.TriggerPid = oom.Memcg, oom.TriggerComm, oom.TriggerPid
		case cause == CauseKilled && hadSig:
			i.TriggerComm, i.TriggerPid = sig.TriggerComm, sig.TriggerPid
			if i.Signal == 0 {
				i.Signal = sig.Signal
			}
		}
	})
	inc.ID = incidentID(host, KindVMDown, ev.VM, ev.Time)
	inc.ContextStallMs, inc.ContextWaitP99Us = e.vmContext(host, ev.VM, ev.Time)
	e.sink.AddIncident(inc)
}

// vmContext sums what the VM's process went through in the 60 s before t: time stalled in reclaim (memstall)
// and its run-queue wait p99 (runqlat), both from the per-process stats filed under "vm:<name>".
func (e *Evaluator) vmContext(host, name string, t time.Time) (stallMs, waitP99Us float64) {
	if e.history == nil {
		return 0, 0
	}
	label := "vm:" + name
	from := t.Add(-60 * time.Second)
	// Samples are stamped at the end of their interval, so the one covering the death arrives up to a second
	// after the exit; let the window reach a little past t
	until := t.Add(2 * time.Second)
	for _, s := range e.history.Samples(host, "memstall") {
		if s.Time.Before(from) || s.Time.After(until) {
			continue
		}
		for _, p := range s.Procs {
			if p.Comm == label {
				stallMs += float64(p.WaitNs) / 1e6
			}
		}
	}
	var slots []uint64
	for _, s := range e.history.Samples(host, "runqlat") {
		if s.Time.Before(from) || s.Time.After(until) {
			continue
		}
		for _, p := range s.Procs {
			if p.Comm != label {
				continue
			}
			if slots == nil {
				slots = make([]uint64, len(p.Slots))
			}
			for i, c := range p.Slots {
				if i < len(slots) {
					slots[i] += c
				}
			}
		}
	}
	if p99, ok := Percentile(slots, 0.99); ok {
		waitP99Us = p99
	}
	return stallMs, waitP99Us
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
		e.closeIfQuiet(&h.cpu, e.cfg.CPU, now, e.culpritDecorator(host, ""))
		e.closeIfQuiet(&h.mem, e.cfg.Memory, now, nil)
		e.closeIfQuiet(&h.gpu, e.cfg.GPU.Starved, now, h.gpuDecorator())
		e.closeIfQuiet(&h.vram, e.cfg.GPU.VRAM, now, nil)
		e.closeIfQuiet(&h.disk, e.cfg.Disk, now, e.ioCulpritDecorator(host))
		e.closeIfQuiet(&h.netFail, e.cfg.Network.ConnectFails, now, e.destDecorator(host, "fails"))
		e.closeIfQuiet(&h.netRetrans, e.cfg.Network.Retrans, now, e.destDecorator(host, "retrans"))
		e.closeIfQuiet(&h.netSlow, e.cfg.Network.ConnectLatency, now, e.destDecorator(host, "slow"))
		for name, ex := range h.vmcpu {
			e.closeIfQuiet(ex, e.cfg.CPU, now, e.culpritDecorator(host, "vm:"+name))
			if !ex.active {
				delete(h.vmcpu, name) // a VM that is quiet (or gone) needs no state
			}
		}
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

// judge advances one excursion with a new value. subject names what is waiting ("" for the host); decorate, if
// set, fills incident fields that need a look at history (who took the CPU) whenever the incident is published.
func (e *Evaluator) judge(x *excursion, host, kind, subject string, r ExcursionRule, v float64, t time.Time, decorate func(*model.Incident)) {
	gap := time.Duration(r.MaxGapSeconds) * time.Second
	if v < r.Caution {
		// Below the threshold. Close the excursion only once the grace period has passed
		if x.active && t.Sub(x.last) > gap {
			e.closeExcursion(x, decorate)
		}
		return
	}
	if x.active && t.Sub(x.last) > gap {
		// The previous excursion ended while no sample below the threshold arrived (e.g. a pause in reporting)
		e.closeExcursion(x, decorate)
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
			ID: incidentID(host, kind, subject, x.first), Host: host, Kind: kind, Level: level,
			Subject: subject, Start: x.first, Updated: t, Seconds: x.seconds, Peak: x.peak,
		}
		if kind == KindVMCPUWait {
			x.open.VM = subject
		}
		x.lastUpsert = t
		if decorate != nil {
			decorate(x.open)
		}
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
			if decorate != nil {
				decorate(x.open)
			}
			e.sink.AddIncident(*x.open)
		}
	}
}

func (e *Evaluator) closeIfQuiet(x *excursion, r ExcursionRule, now time.Time, decorate func(*model.Incident)) {
	// A bit more slack than the sample-driven path, since samples normally arrive once a second
	if x.active && now.Sub(x.last) > time.Duration(r.MaxGapSeconds+2)*time.Second {
		e.closeExcursion(x, decorate)
	}
}

func (e *Evaluator) closeExcursion(x *excursion, decorate func(*model.Incident)) {
	if x.open != nil {
		end := x.last
		x.open.End, x.open.Seconds, x.open.Peak, x.open.Updated = &end, x.seconds, x.peak, end
		if decorate != nil {
			decorate(x.open)
		}
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
