package trigger

import (
	"testing"
	"time"

	"github.com/yoshiharu-ishii/ebpf-lens/internal/model"
)

// recorder keeps every upsert so a test can check the whole story of an incident, not just its final state.
type recorder struct{ got []model.Incident }

func (r *recorder) AddIncident(i model.Incident) { r.got = append(r.got, i) }

func (r *recorder) last() model.Incident { return r.got[len(r.got)-1] }

var t0 = time.Date(2026, 9, 27, 10, 0, 0, 0, time.UTC)

// A runqlat sample whose p99 lands in slot i (all counts in one slot make p99 fall inside it).
func cpuSample(sec int, slot int) model.Sample {
	slots := make([]uint64, 27)
	slots[slot] = 100
	return model.Sample{Host: "h", Probe: "runqlat", Time: t0.Add(time.Duration(sec) * time.Second), Slots: slots}
}

func memSample(sec int, stallMs float64) model.Sample {
	return model.Sample{
		Host: "h", Probe: "memstall", Time: t0.Add(time.Duration(sec) * time.Second), IntervalMs: 1000,
		Mem: &model.MemStat{StallNs: uint64(stallMs * 1e6)},
	}
}

func TestPercentileMatchesFrontend(t *testing.T) {
	// 100 events in slot 3 ([8, 16) µs): p99 interpolates to 8 + 8*0.99 = 15.92
	if p, ok := Percentile(cpuSample(0, 3).Slots, 0.99); !ok || p < 15.9 || p > 16 {
		t.Fatalf("p99 = %v, %v; want about 15.92", p, ok)
	}
	if _, ok := Percentile(make([]uint64, 27), 0.99); ok {
		t.Fatal("empty histogram must report no percentile")
	}
}

// Recorded on the test machine: 4x CPU oversubscription moves the p99 from slot 3 (8-15 µs) to slot 13 (8-16 ms).
func TestCPUExcursionOpensEscalatesAndCloses(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)

	e.OnSample(cpuSample(0, 3))  // idle
	e.OnSample(cpuSample(1, 10)) // 1 ms: over caution, not yet an incident
	e.OnSample(cpuSample(2, 10))
	if len(r.got) != 0 {
		t.Fatalf("incident opened after 2 s; MinSeconds is 3")
	}
	e.OnSample(cpuSample(3, 10))
	if len(r.got) != 1 || r.last().Kind != KindCPUWait || r.last().Level != LevelCaution || !r.last().Ongoing() {
		t.Fatalf("expected an ongoing caution incident after 3 s, got %+v", r.got)
	}
	if !r.last().Start.Equal(t0.Add(time.Second)) {
		t.Fatalf("incident must start at the first second over the threshold, got %v", r.last().Start)
	}

	// Three seconds at 8-16 ms escalate it to a warning, published immediately
	for s := 4; s <= 6; s++ {
		e.OnSample(cpuSample(s, 13))
	}
	if r.last().Level != LevelWarning || r.last().Peak < 8000 {
		t.Fatalf("expected escalation to warning with peak in the ms range, got %+v", r.last())
	}

	// Back to idle: a 2 s gap is tolerated, the third idle second closes it, End is the last bad second
	e.OnSample(cpuSample(7, 3))
	e.OnSample(cpuSample(8, 3))
	if !r.last().Ongoing() {
		t.Fatal("closed inside the grace period")
	}
	e.OnSample(cpuSample(9, 3))
	got := r.last()
	if got.Ongoing() || !got.End.Equal(t0.Add(6*time.Second)) || got.Seconds != 6 || got.Level != LevelWarning {
		t.Fatalf("expected closed warning ending at +6 s with 6 s duration, got %+v", got)
	}
	for _, x := range r.got {
		if x.ID != got.ID {
			t.Fatalf("the ID must stay stable across updates: %s vs %s", x.ID, got.ID)
		}
	}
}

func TestShortSpikeIsNotAnIncident(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	e.OnSample(cpuSample(0, 13))
	e.OnSample(cpuSample(1, 13))
	for s := 2; s < 10; s++ {
		e.OnSample(cpuSample(s, 3))
	}
	if len(r.got) != 0 {
		t.Fatalf("a 2 s spike must not open an incident, got %+v", r.got)
	}
}

func TestExcursionClosesWhenSamplesStop(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	for s := 0; s < 5; s++ {
		e.OnSample(memSample(s, 50)) // 50 ms/s: caution
	}
	if len(r.got) == 0 || r.last().Kind != KindMemStall || !r.last().Ongoing() {
		t.Fatalf("expected an ongoing mem_stall incident, got %+v", r.got)
	}
	e.Tick(t0.Add(6 * time.Second)) // still within the grace period
	if !r.last().Ongoing() {
		t.Fatal("closed too early on tick")
	}
	e.Tick(t0.Add(10 * time.Second))
	if r.last().Ongoing() || !r.last().End.Equal(t0.Add(4*time.Second)) {
		t.Fatalf("expected the tick to close it at the last bad second, got %+v", r.last())
	}
}

// Recorded in the test VM: an OOM kill of python3 triggered by itself, machine-wide (memcg=false).
func TestOOMKillIsAnInstantWarning(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	e.OnEvents(model.EventBatch{Host: "h", Time: t0, Events: []model.ProcEvent{{
		Time: t0, Kind: "oom", Pid: 2407, Comm: "python3", TriggerPid: 2407, TriggerComm: "python3", TotalPages: 244727,
	}}})
	if len(r.got) != 1 {
		t.Fatalf("expected exactly one incident, got %d", len(r.got))
	}
	got := r.last()
	if got.Kind != KindOOMKill || got.Level != LevelWarning || got.Subject != "python3" || got.Ongoing() || !got.End.Equal(got.Start) || got.Memcg {
		t.Fatalf("unexpected incident %+v", got)
	}
}

func TestCrashLoopAfterThreeCrashes(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	crash := func(sec int, pid uint32) model.ProcEvent {
		return model.ProcEvent{Time: t0.Add(time.Duration(sec) * time.Second), Kind: "exit", Pid: pid, Comm: "flaky-app", Signal: 11, CoreDump: true}
	}
	e.OnEvents(model.EventBatch{Host: "h", Events: []model.ProcEvent{crash(0, 100)}})
	e.OnEvents(model.EventBatch{Host: "h", Events: []model.ProcEvent{crash(4, 101)}})
	if len(r.got) != 2 { // two instant crash incidents, no loop yet
		t.Fatalf("expected 2 crash incidents, got %d", len(r.got))
	}
	e.OnEvents(model.EventBatch{Host: "h", Events: []model.ProcEvent{crash(9, 102)}})
	loop := r.last()
	if loop.Kind != KindCrashLoop || loop.Level != LevelWarning || loop.Count != 3 || !loop.Ongoing() || !loop.Start.Equal(t0) {
		t.Fatalf("expected an ongoing crash_loop with 3 crashes starting at the first crash, got %+v", loop)
	}
	// SIGTERM is not a crash and must not count
	e.OnEvents(model.EventBatch{Host: "h", Events: []model.ProcEvent{{Time: t0.Add(12 * time.Second), Kind: "exit", Pid: 103, Comm: "flaky-app", Signal: 15}}})
	if r.last().Kind != KindCrashLoop || r.last().Count != 3 {
		t.Fatalf("SIGTERM counted as a crash: %+v", r.last())
	}
	// Quiet for longer than the window closes the loop at the last crash
	e.Tick(t0.Add(9*time.Second + 301*time.Second))
	if r.last().Kind != KindCrashLoop || r.last().Ongoing() || !r.last().End.Equal(t0.Add(9*time.Second)) {
		t.Fatalf("expected the loop to close at the last crash, got %+v", r.last())
	}
}

func TestAgentDownOpensAndClosesWhenSamplesResume(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	e.OnSample(cpuSample(0, 3))
	e.Tick(t0.Add(20 * time.Second))
	if len(r.got) != 0 {
		t.Fatalf("20 s of silence must not be an incident yet, got %+v", r.got)
	}
	e.Tick(t0.Add(31 * time.Second))
	if len(r.got) != 1 || r.last().Kind != KindAgentDown || !r.last().Ongoing() || !r.last().Start.Equal(t0) {
		t.Fatalf("expected an ongoing agent_down starting at the last sample, got %+v", r.got)
	}
	e.OnSample(cpuSample(45, 3))
	got := r.last()
	if got.Kind != KindAgentDown || got.Ongoing() || got.Seconds != 45 {
		t.Fatalf("expected agent_down closed after 45 s, got %+v", got)
	}
}

func TestConfigValidation(t *testing.T) {
	c := Default()
	c.CPU.Warning = 500 // below caution
	if err := c.Validate(); err == nil {
		t.Fatal("warning below caution must be rejected")
	}
	if err := Default().Validate(); err != nil {
		t.Fatalf("defaults must validate: %v", err)
	}
}

func TestNotifierTextReadsLikeAChatLine(t *testing.T) {
	end := t0.Add(31 * time.Second)
	got := Text("close", model.Incident{Host: "hal", Kind: KindCPUWait, Level: LevelWarning, Start: t0, End: &end, Seconds: 31, Peak: 16346})
	want := "[RESOLVED] hal: processes are competing for CPU (99% of tasks waited up to 16.3 ms, 31 s since 10:00:00)"
	if got != want {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
}

func TestMarkSeenLetsAgentDownFireAfterRestart(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	e.MarkSeen("h", t0) // restored from the DB at startup; no live sample yet
	e.Tick(t0.Add(31 * time.Second))
	if len(r.got) != 1 || r.last().Kind != KindAgentDown || !r.last().Start.Equal(t0) {
		t.Fatalf("expected agent_down from the restored last-seen time, got %+v", r.got)
	}
}

// history with one memstall and one runqlat sample for VM web-02 in the minute before it dies.
type fakeHistory struct{ samples map[string][]model.Sample }

func (f fakeHistory) Samples(host, probe string) []model.Sample { return f.samples[probe] }

func vmHistory() fakeHistory {
	slots := make([]uint64, 27)
	slots[13] = 50 // 8-16 ms wait
	return fakeHistory{samples: map[string][]model.Sample{
		"memstall": {
			{Host: "h", Probe: "memstall", Time: t0.Add(-30 * time.Second), Procs: []model.ProcStat{{Comm: "vm:web-02", WaitNs: 100e6}}},
			// the interval in which the VM died is stamped after the exit and must still count
			{Host: "h", Probe: "memstall", Time: t0.Add(900 * time.Millisecond), Procs: []model.ProcStat{{Comm: "vm:web-02", WaitNs: 20e6}}},
		},
		"runqlat": {{Host: "h", Probe: "runqlat", Time: t0.Add(-20 * time.Second), Procs: []model.ProcStat{{Comm: "vm:web-02", Slots: slots}}}},
	}}
}

// Recorded in the lab: an OOM kill event is followed by the SIGKILL exit of the same pid.
func TestVMDownAfterOOMNamesTheCauseAndContext(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	e.SetHistory(vmHistory())
	e.OnEvents(model.EventBatch{Host: "h", Time: t0, Events: []model.ProcEvent{
		{Time: t0, Kind: "oom", Pid: 4242, Comm: "qemu-system-x86", VM: "web-02", TriggerPid: 7001, TriggerComm: "vzdump", Memcg: false},
		{Time: t0.Add(50 * time.Millisecond), Kind: "exit", Pid: 4242, Comm: "qemu-system-x86", VM: "web-02", Signal: 9},
	}})
	if len(r.got) != 2 || r.got[0].Kind != KindOOMKill || r.got[1].Kind != KindVMDown {
		t.Fatalf("expected oom_kill then vm_down, got %+v", r.got)
	}
	vm := r.got[1]
	if vm.Level != LevelWarning || vm.Cause != CauseHostOOM || vm.VM != "web-02" || vm.TriggerComm != "vzdump" || vm.Signal != 9 {
		t.Fatalf("unexpected vm_down %+v", vm)
	}
	if vm.ContextStallMs != 120 || vm.ContextWaitP99Us < 8000 {
		t.Fatalf("context not attached: stall=%v p99=%v", vm.ContextStallMs, vm.ContextWaitP99Us)
	}
	if vm.Ongoing() || !vm.End.Equal(vm.Start) {
		t.Fatal("vm_down is an instant incident")
	}
	// The plain crash rule must not fire a second incident for the same exit (a SIGKILL is not a crash anyway)
	for _, x := range r.got {
		if x.Kind == KindCrash {
			t.Fatal("a VM exit must not also be reported as a process crash")
		}
	}
}

func TestVMDownCauses(t *testing.T) {
	cases := []struct {
		name  string
		ev    model.ProcEvent
		cause string
		level string
	}{
		{"segv", model.ProcEvent{Kind: "exit", Signal: 11, CoreDump: true}, CauseCrash, LevelWarning},
		{"sigterm", model.ProcEvent{Kind: "exit", Signal: 15}, CauseKilled, LevelCaution},
		{"clean", model.ProcEvent{Kind: "exit", ExitStatus: 0}, CauseShutdown, LevelCaution},
	}
	for _, c := range cases {
		r := &recorder{}
		e := New(Default(), r)
		ev := c.ev
		ev.Time, ev.Pid, ev.Comm, ev.VM = t0, 4242, "qemu-system-x86", "web-02"
		e.OnEvents(model.EventBatch{Host: "h", Time: t0, Events: []model.ProcEvent{ev}})
		if len(r.got) != 1 || r.got[0].Kind != KindVMDown || r.got[0].Cause != c.cause || r.got[0].Level != c.level {
			t.Fatalf("%s: got %+v, want cause=%s level=%s", c.name, r.got, c.cause, c.level)
		}
	}
}

func TestCgroupOOMIsDistinguished(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	e.OnEvents(model.EventBatch{Host: "h", Time: t0, Events: []model.ProcEvent{
		{Time: t0, Kind: "oom", Pid: 1, Comm: "qemu-system-x86", VM: "web-02", TriggerPid: 1, TriggerComm: "qemu-system-x86", Memcg: true},
		{Time: t0, Kind: "exit", Pid: 1, Comm: "qemu-system-x86", VM: "web-02", Signal: 9},
	}})
	if got := r.last(); got.Kind != KindVMDown || got.Cause != CauseCgroupOOM || !got.Memcg {
		t.Fatalf("expected cgroup_oom, got %+v", got)
	}
	want := "[WARNING] h: VM web-02 stopped at 10:00:00: its cgroup memory limit was reached; triggered by qemu-system-x86 (pid 1)"
	if txt := Text("open", r.last()); txt != want {
		t.Fatalf("text\n got %q\nwant %q", txt, want)
	}
}

// Recorded in the lab: "virsh destroy" makes virtqemud send SIGTERM; QEMU handles it and exits 0.
// Only the signal event tells this apart from a guest shutdown, and it names who did it.
func TestVMDownKilledBySignalSeenBeforeCleanExit(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	e.OnEvents(model.EventBatch{Host: "h", Time: t0, Events: []model.ProcEvent{
		{Time: t0, Kind: "signal", Pid: 4242, Comm: "qemu-system-x86", VM: "web-02", Signal: 15, TriggerPid: 900, TriggerComm: "virtqemud"},
		{Time: t0.Add(200 * time.Millisecond), Kind: "exit", Pid: 4242, Comm: "qemu-system-x86", VM: "web-02", ExitStatus: 0},
	}})
	got := r.last()
	if got.Kind != KindVMDown || got.Cause != CauseKilled || got.Signal != 15 || got.TriggerComm != "virtqemud" || got.Level != LevelCaution {
		t.Fatalf("expected killed by virtqemud with SIGTERM, got %+v", got)
	}
	want := "[CAUTION] h: VM web-02 stopped at 10:00:00: QEMU was stopped with signal 15 by virtqemud (pid 900): a managed shutdown or a virsh destroy"
	if txt := Text("open", got); txt != want {
		t.Fatalf("text\n got %q\nwant %q", txt, want)
	}
}
