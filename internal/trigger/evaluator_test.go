package trigger

import (
	"fmt"
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

func TestGroupCulprits(t *testing.T) {
	// one hog
	g, tot := GroupCulprits(map[string]float64{"stress-ng-cpu": 0.99, "steam": 0.002})
	if len(g) != 1 || g[0].Name != "stress-ng-cpu" || tot < 0.99 {
		t.Fatalf("single hog: %+v %v", g, tot)
	}
	// three neighbours at 34/24/23 % (recorded on the test host) are one group of three
	g, tot = GroupCulprits(map[string]float64{"vm:f1": 0.34, "vm:f2": 0.24, "vm:f3": 0.23, "dd": 0.009, "ebpflens-server": 0.003})
	if len(g) != 3 || g[0].Name != "vm:f1" || g[2].Name != "vm:f3" || tot < 0.80 || tot > 0.82 {
		t.Fatalf("three neighbours: %+v %v", g, tot)
	}
	// ten processes at 7 % each: nobody stands out
	many := map[string]float64{}
	for i := 0; i < 10; i++ {
		many[fmt.Sprintf("w%d", i)] = 0.07
	}
	if g, _ := GroupCulprits(many); g != nil {
		t.Fatalf("no group expected for evenly shared CPU, got %+v", g)
	}
	// two at 20 % do not reach 50 % together: no group
	if g, _ := GroupCulprits(map[string]float64{"a": 0.2, "b": 0.2}); g != nil {
		t.Fatalf("40 %% together must not be a group, got %+v", g)
	}
}

// History for the fleet run: three VMs hog the CPU while fleet-08 waits.
func fleetHistory(secs int) fakeHistory {
	var xs []model.Sample
	for s := 0; s < secs; s++ {
		xs = append(xs, model.Sample{
			Host: "h", Probe: "runqlat", Time: t0.Add(time.Duration(s) * time.Second), IntervalMs: 1000, CPUs: 8, BusyNs: 5.7e9,
			Procs: []model.ProcStat{
				{Comm: "vm:fleet-01", OnCPUNs: 2.7e9}, {Comm: "vm:fleet-02", OnCPUNs: 1.9e9}, {Comm: "vm:fleet-03", OnCPUNs: 1.85e9},
				{Comm: "vm:fleet-08", OnCPUNs: 0.01e9},
			},
		})
	}
	return fakeHistory{samples: map[string][]model.Sample{"runqlat": xs}}
}

func TestVMCPUWaitOpensWithCulpritsExcludingItself(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	e.SetHistory(fleetHistory(10))
	slots := make([]uint64, 27)
	slots[11] = 100 // 2-4 ms: over caution for the VM
	for s := 0; s < 3; s++ {
		e.OnSample(model.Sample{
			Host: "h", Probe: "runqlat", Time: t0.Add(time.Duration(s) * time.Second), IntervalMs: 1000, CPUs: 8,
			Slots: cpuSample(s, 3).Slots, // the host as a whole is fine
			Procs: []model.ProcStat{{Comm: "vm:fleet-08", Slots: slots}, {Comm: "vm:fleet-01", Slots: cpuSample(s, 3).Slots}},
		})
	}
	if len(r.got) != 1 {
		t.Fatalf("expected exactly one incident (the VM's), got %+v", r.got)
	}
	got := r.last()
	if got.Kind != KindVMCPUWait || got.VM != "fleet-08" || got.Subject != "fleet-08" || got.Level != LevelCaution || !got.Ongoing() {
		t.Fatalf("unexpected incident %+v", got)
	}
	if len(got.Culprits) != 3 || got.Culprits[0].Name != "vm:fleet-01" || got.CulpritShare < 0.79 || got.HostBusy < 0.70 {
		t.Fatalf("culprits not attached or wrong: %+v share=%v busy=%v", got.Culprits, got.CulpritShare, got.HostBusy)
	}
	for _, c := range got.Culprits {
		if c.Name == "vm:fleet-08" {
			t.Fatal("the waiting VM must not be its own culprit")
		}
	}
	want := "[CAUTION] h: VM fleet-08 is waiting for host CPU (99% of its tasks waited up to 4.1 ms, 3 s since 10:00:00); CPU taken by vm:fleet-01 (34%), vm:fleet-02 (24%), vm:fleet-03 (23%) — 81% together"
	if txt := Text("open", got); txt != want {
		t.Fatalf("text\n got %q\nwant %q", txt, want)
	}
}

func TestHostCPUWaitCarriesCulprits(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	e.SetHistory(fleetHistory(10))
	for s := 0; s < 3; s++ {
		x := cpuSample(s, 13)
		x.IntervalMs, x.CPUs = 1000, 8
		e.OnSample(x)
	}
	got := r.last()
	if got.Kind != KindCPUWait || len(got.Culprits) != 3 || got.Culprits[0].Name != "vm:fleet-01" {
		t.Fatalf("host cpu_wait should name the group: %+v", got)
	}
}

// A gpu sample: the GPU at util, and one CUDA process that spent cpuMs on the CPU and copyMs inside copy calls.
func gpuSample(sec int, util float64, comm string, cpuMs, copyMs float64, vramShare float64) model.Sample {
	return model.Sample{
		Host: "h", Probe: "gpu", Time: t0.Add(time.Duration(sec) * time.Second), IntervalMs: 1000, Slots: []uint64{0},
		GPU: &model.GPUStat{
			Util: util, UsedBytes: uint64(vramShare * float64(8<<30)), TotalBytes: 8 << 30,
			Procs: []model.GPUProc{{Comm: comm, OnCPUNs: uint64(cpuMs * 1e6), CopyNs: uint64(copyMs * 1e6)}},
		},
	}
}

// Recorded on the test machine: a PyTorch process feeding a 4096x4096 matmul from pageable memory spent 982 ms/s
// inside cuMemcpyHtoDAsync (5.1 GB/s) with the GPU busy only part of the time. A starved GPU is one whose
// process is fully busy elsewhere while the GPU sits below idleUtil.
func TestGPUStarvedNamesTheProcessAndHow(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	for s := 0; s < 9; s++ {
		e.OnSample(gpuSample(s, 0.05, "python", 950, 40, 0.3)) // busy on the CPU, GPU idle
	}
	if len(r.got) != 0 {
		t.Fatalf("opened after 9 s; MinSeconds is 10")
	}
	e.OnSample(gpuSample(9, 0.05, "python", 950, 40, 0.3))
	if len(r.got) != 1 || r.last().Kind != KindGPUStarved || r.last().Subject != "python" || r.last().Level != LevelWarning {
		t.Fatalf("expected a gpu_starved warning naming python, got %+v", r.got)
	}
	if i := r.last(); i.GPUUtil != 0.05 || i.CPUShare != 0.95 || i.CopyShare != 0.04 {
		t.Fatalf("incident must carry util and shares, got util=%v cpu=%v copy=%v", i.GPUUtil, i.CPUShare, i.CopyShare)
	}
	text := Text("open", r.last())
	if !contains(text, "GPU is idle (5% busy)") || !contains(text, "python is working on the CPU") {
		t.Fatalf("text: %s", text)
	}
	// The GPU gets busy: no incident while util is above idleUtil, and the excursion closes after the gap
	for s := 10; s < 20; s++ {
		e.OnSample(gpuSample(s, 0.9, "python", 100, 0, 0.3))
	}
	if r.last().Ongoing() {
		t.Fatalf("incident must close once the GPU is busy, got %+v", r.last())
	}
}

func TestGPUCopyBoundReadsAsCopying(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	for s := 0; s < 10; s++ {
		e.OnSample(gpuSample(s, 0.1, "python", 300, 700, 0.3))
	}
	if len(r.got) != 1 || r.last().Level != LevelCaution {
		t.Fatalf("expected one caution (score 0.7), got %+v", r.got)
	}
	if text := Text("open", r.last()); !contains(text, "copying data to or from the GPU") {
		t.Fatalf("text: %s", text)
	}
}

func TestGPUIdleWithoutWorkIsNotStarved(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	for s := 0; s < 20; s++ {
		e.OnSample(gpuSample(s, 0, "python", 5, 0, 0.3)) // a loaded model doing nothing is fine
	}
	if len(r.got) != 0 {
		t.Fatalf("an idle process must not count as starving the GPU, got %+v", r.got)
	}
}

func TestVRAMFullOpensAtNinetyPercent(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	for s := 0; s < 3; s++ {
		e.OnSample(gpuSample(s, 0.9, "python", 100, 0, 0.95))
	}
	if len(r.got) != 1 || r.last().Kind != KindVRAMFull || r.last().Level != LevelCaution || r.last().Peak < 0.949 || r.last().Peak > 0.951 {
		t.Fatalf("expected a vram_full caution with peak 0.95, got %+v", r.got)
	}
	if text := Text("open", r.last()); !contains(text, "VRAM is 95% full") {
		t.Fatalf("text: %s", text)
	}
}

func contains(s, sub string) bool { return len(s) >= len(sub) && (s == sub || indexOf(s, sub) >= 0) }

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// A biolat sample whose p99 lands in slot i, with processes that issued the given bytes.
func diskSample(sec, slot int, issuers map[string]uint64, errors uint64) model.Sample {
	slots := make([]uint64, 27)
	slots[slot] = 100
	x := model.Sample{Host: "h", Probe: "biolat", Time: t0.Add(time.Duration(sec) * time.Second), IntervalMs: 1000, Slots: slots,
		Disk: &model.DiskStat{Devices: []model.DiskDev{{Name: "sda", Reads: 100, Errors: errors}}}}
	for comm, b := range issuers {
		x.Procs = append(x.Procs, model.ProcStat{Comm: comm, WriteBytes: b})
	}
	return x
}

// Recorded on the test machine: dd with oflag=direct at 1 MB blocks moves the SATA SSD's per-second p99 from
// slot 7-8 (128-512 µs) to slot 13 (8-16 ms). The incident names who issued the bytes.
func TestDiskSlowNamesTheIssuer(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	e.SetHistory(&fakeHistory{samples: map[string][]model.Sample{}})
	h := e.history.(*fakeHistory)
	for s := 0; s < 3; s++ {
		x := diskSample(s, 13, map[string]uint64{"dd": 950 << 20, "postgres": 50 << 20}, 0)
		h.samples["biolat"] = append(h.samples["biolat"], x)
		e.OnSample(x)
	}
	if len(r.got) != 1 || r.last().Kind != KindDiskSlow || r.last().Level != LevelCaution {
		t.Fatalf("expected one disk_slow caution after 3 s, got %+v", r.got)
	}
	if c := r.last().Culprits; len(c) != 1 || c[0].Name != "dd" || c[0].Share < 0.94 || c[0].Share > 0.96 {
		t.Fatalf("culprits: %+v", c)
	}
	if text := Text("open", r.last()); !contains(text, "block I/O is slow") || !contains(text, "I/O issued mostly by dd (95%)") {
		t.Fatalf("text: %s", text)
	}
}

func TestDiskErrorIsAnInstantWarning(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	e.OnSample(diskSample(0, 7, nil, 2))
	if len(r.got) != 1 || r.last().Kind != KindDiskError || r.last().Level != LevelWarning || r.last().Device != "sda" || r.last().Count != 2 || r.last().Ongoing() {
		t.Fatalf("expected an instant disk_error warning on sda with 2 errors, got %+v", r.got)
	}
	if text := Text("open", r.last()); !contains(text, "sda returned 2 I/O error(s)") {
		t.Fatalf("text: %s", text)
	}
}

// A tcpconn sample: connect p99 in slot `slot`, and destinations with the given failures / retransmits.
func netSample(sec, slot int, dests []model.NetDest) model.Sample {
	slots := make([]uint64, 27)
	if slot >= 0 {
		slots[slot] = 100
	}
	return model.Sample{Host: "h", Probe: "tcpconn", Time: t0.Add(time.Duration(sec) * time.Second), IntervalMs: 1000, Slots: slots,
		Net: &model.NetStat{Dests: dests}}
}

func TestNetConnectFailNamesTheDestination(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	h := &fakeHistory{samples: map[string][]model.Sample{}}
	e.SetHistory(h)
	for s := 0; s < 3; s++ {
		x := netSample(s, -1, []model.NetDest{{Addr: "10.0.0.5", Port: 5432, Fails: 4}, {Addr: "10.0.0.9", Port: 443, Connects: 3}})
		h.samples["tcpconn"] = append(h.samples["tcpconn"], x)
		e.OnSample(x)
	}
	// 4 failures per second: the 10 s window holds 4, then 8 (opens: caution is 5 in 10 s). The third second
	// (12) is progress, which is published every 5 s, so the last upsert still says 8
	if len(r.got) != 1 || r.last().Kind != KindNetConnectFail || r.last().Level != LevelCaution || r.last().Peak != 8 || !r.got[0].Start.Equal(t0.Add(time.Second)) {
		t.Fatalf("expected a net_connect_fail caution opening at second 1 with peak 8, got %+v", r.got)
	}
	if c := r.last().Culprits; len(c) != 1 || c[0].Name != "10.0.0.5:5432" || c[0].Share != 1 {
		t.Fatalf("culprits: %+v", c)
	}
	if text := Text("open", r.last()); !contains(text, "connects are failing (8 in 10 s") || !contains(text, "mostly to 10.0.0.5:5432 (100%)") {
		t.Fatalf("text: %s", text)
	}
}

// A connect p99 in slot 20 (1-2 s) means the SYN was retransmitted: warning, not just caution.
func TestNetConnectSlowAtOneSecondIsPacketLoss(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	for s := 0; s < 3; s++ {
		e.OnSample(netSample(s, 20, nil))
	}
	if len(r.got) != 1 || r.last().Kind != KindNetConnectSlow || r.last().Level != LevelWarning {
		t.Fatalf("expected a net_connect_slow warning, got %+v", r.got)
	}
	if text := Text("open", r.last()); !contains(text, "SYN itself is being retransmitted") {
		t.Fatalf("text: %s", text)
	}
}

func TestNetRetransOpensAtTenPerSecond(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	for s := 0; s < 3; s++ {
		e.OnSample(netSample(s, -1, []model.NetDest{{Addr: "192.168.10.250", Port: 8080, Retrans: 12}}))
	}
	if len(r.got) != 1 || r.last().Kind != KindNetRetrans || r.last().Level != LevelCaution || r.last().Peak != 12 {
		t.Fatalf("expected a net_retrans caution at 12/s, got %+v", r.got)
	}
}

// NetworkManager's connectivity check on a host without an IPv6 route: a dozen addresses of one /64, one failure
// each. No address:port reaches 10 %, so the group is formed per /64 instead of saying nothing.
func TestNetConnectFailGroupsByPrefixWhenNoDestinationStandsOut(t *testing.T) {
	r := &recorder{}
	e := New(Default(), r)
	h := &fakeHistory{samples: map[string][]model.Sample{}}
	e.SetHistory(h)
	var dests []model.NetDest
	for i := 0; i < 8; i++ {
		dests = append(dests, model.NetDest{Addr: fmt.Sprintf("2620:2d:4000:1::%d", 0x1000+i), Port: 443, Fails: 1})
	}
	for i := 0; i < 4; i++ {
		dests = append(dests, model.NetDest{Addr: fmt.Sprintf("2620:2d:4002:1::%d", 0x1000+i), Port: 80, Fails: 1})
	}
	x := netSample(0, -1, dests)
	h.samples["tcpconn"] = append(h.samples["tcpconn"], x)
	e.OnSample(x)
	if len(r.got) != 1 {
		t.Fatalf("expected one incident (12 failures in 10 s), got %+v", r.got)
	}
	c := r.last().Culprits
	if len(c) != 2 || c[0].Name != "2620:2d:4000:1::/64" || c[0].Share < 0.66 || c[0].Share > 0.67 || c[1].Name != "2620:2d:4002:1::/64" {
		t.Fatalf("culprits: %+v", c)
	}
	if destBlock("10.0.0.5:5432") != "10.0.0.5" || destBlock("clients at 192.168.10.4") != "192.168.10.4" {
		t.Fatalf("destBlock v4: %q %q", destBlock("10.0.0.5:5432"), destBlock("clients at 192.168.10.4"))
	}
}
