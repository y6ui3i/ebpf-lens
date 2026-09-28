// Package model defines the data types shared by the agent, the server, and the frontend.
// The frontend types are generated into frontend/src/types/model.ts with tygo (make types).
package model

import "time"

// Sample is a histogram for one interval. Slots[i] is the count in [2^i, 2^(i+1))
// (slot 0 alone is [0, 2)). Values are in Unit.
type Sample struct {
	Host       string     `json:"host"`
	Time       time.Time  `json:"time"`
	Probe      string     `json:"probe"`
	Unit       string     `json:"unit"`
	Slots      []uint64   `json:"slots"`
	IntervalMs int64      `json:"intervalMs"` // Length of the aggregation interval
	CPUs       int        `json:"cpus"`       // Used as the denominator for CPU utilization
	BusyNs     uint64     `json:"busyNs"`     // Total CPU time used by all processes (measured with eBPF; excludes idle)
	Procs      []ProcStat `json:"procs,omitempty"`
	Mem        *MemStat   `json:"mem,omitempty"`  // memstall only
	VMs        []VMInfo   `json:"vms,omitempty"`  // probe "vms" only: the VMs running on this host
	GPU        *GPUStat   `json:"gpu,omitempty"`  // probe "gpu" only. Its Slots are a histogram of how long CUDA calls waited for the GPU
	Disk       *DiskStat  `json:"disk,omitempty"` // probe "biolat" only. Its Slots are a histogram of block I/O latency (issue to completion)
	Net        *NetStat   `json:"net,omitempty"`  // probe "tcpconn" only. Its Slots are a histogram of TCP connect latency (SYN sent to established)
	DNS        *DNSStat   `json:"dns,omitempty"`  // probe "dnslat" only. Its Slots are a histogram of getaddrinfo latency
}

// DNSStat is one interval of name resolution (glibc getaddrinfo) per name. Procs on the same sample say who resolved.
type DNSStat struct {
	Names []DNSName `json:"names"`
}

// DNSName is one looked-up name during the interval (the first 63 bytes of it).
type DNSName struct {
	Name      string `json:"name"`
	Lookups   uint64 `json:"lookups"`
	Fails     uint64 `json:"fails"`
	LatNs     uint64 `json:"latNs"`
	LatMaxNs  uint64 `json:"latMaxNs"`
	LastError string `json:"lastError,omitempty"` // EAI_* name of the last failure: "NONAME" (no such name), "AGAIN" (no answer in time), "FAIL", ...
}

// NetStat is one interval of outbound TCP activity per destination. Procs on the same sample say who connected.
type NetStat struct {
	Dests []NetDest `json:"dests"`
}

// NetDest is one destination (address and port) during the interval.
type NetDest struct {
	Addr     string `json:"addr"`
	Port     uint16 `json:"port"`     // 0: an inbound connection from Addr (retransmits toward a client), where the client's port is noise
	Connects uint64 `json:"connects"` // connections established
	Fails    uint64 `json:"fails"`    // connects that ended in CLOSE without being established (refused, unreachable, timed out)
	Retrans  uint64 `json:"retrans"`  // segments retransmitted to this destination (established connections included)
	LatNs    uint64 `json:"latNs"`    // total connect latency of the established ones
	LatMaxNs uint64 `json:"latMaxNs"`
}

// DiskStat is one interval of block I/O per device. Procs on the same sample say who issued the I/O.
type DiskStat struct {
	Devices []DiskDev `json:"devices"`
}

// DiskDev is one block device's I/O during the interval.
type DiskDev struct {
	Name       string   `json:"name"` // "nvme0n1", "sda"
	Reads      uint64   `json:"reads"`
	Writes     uint64   `json:"writes"`
	ReadBytes  uint64   `json:"readBytes"`
	WriteBytes uint64   `json:"writeBytes"`
	Errors     uint64   `json:"errors"` // completions with a block status other than OK
	LatNs      uint64   `json:"latNs"`  // total latency of the completed I/Os
	LatMaxNs   uint64   `json:"latMaxNs"`
	Slots      []uint64 `json:"slots"` // log2 histogram of latency (µs)
}

// GPUStat is one interval of the first GPU (NVML) plus what the CUDA processes did meanwhile (eBPF uprobes on libcuda).
// NVML is the one source in eBPFLens that is not eBPF: the GPU's own counters live in the driver, not in the kernel's
// tracepoints (docs/adr/0003). Everything per process comes from the uprobes.
type GPUStat struct {
	Name       string    `json:"name"`
	Util       float64   `json:"util"`       // share of the interval a kernel was running, 0..1 (NVML "GPU utilization")
	MemUtil    float64   `json:"memUtil"`    // share of the interval the memory bus was busy, 0..1
	UsedBytes  uint64    `json:"usedBytes"`  // VRAM in use
	TotalBytes uint64    `json:"totalBytes"` // VRAM total
	TempC      int       `json:"tempC"`
	PowerW     float64   `json:"powerW"`
	Throttle   []string  `json:"throttle,omitempty"` // why the clocks are held back right now: "power", "thermal", "hw" (empty when they are not)
	Uprobes    bool      `json:"uprobes"`            // whether the libcuda uprobes are attached (false: no libcuda on this host, per-process fields stay 0)
	Procs      []GPUProc `json:"procs,omitempty"`
}

// GPUProc is what one CUDA process (merged by name) did on the GPU during the interval.
// The verdict "why is the GPU idle" is drawn from these by the UI and the trigger rules:
// a process that is on the CPU or copying while the GPU is idle is starving it; one that is inside a
// synchronize call is waiting for it; one that does neither is waiting for something else (I/O, a lock, input).
type GPUProc struct {
	Comm      string   `json:"comm"`
	Procs     int      `json:"procs"`
	Pids      []uint32 `json:"pids"`
	VRAMBytes uint64   `json:"vramBytes"` // from NVML (the driver's view of the process)
	Launches  uint64   `json:"launches"`  // kernel launches (cuLaunchKernel, cuGraphLaunch)
	H2DBytes  uint64   `json:"h2dBytes"`  // bytes copied host -> GPU
	D2HBytes  uint64   `json:"d2hBytes"`  // bytes copied GPU -> host
	CopyNs    uint64   `json:"copyNs"`    // time inside copy calls (a copy from pageable memory blocks in the call)
	CopyCount uint64   `json:"copyCount"`
	SyncNs    uint64   `json:"syncNs"` // time inside cuStreamSynchronize / cuCtxSynchronize / cuEventSynchronize: waiting for the GPU
	SyncCount uint64   `json:"syncCount"`
	OnCPUNs   uint64   `json:"onCpuNs"` // CPU time of the process in the same interval (from runqlat), for "busy on the CPU instead"
}

// VMInfo is one virtual machine (a QEMU process) running on the host.
type VMInfo struct {
	Name  string    `json:"name"`
	Pid   uint32    `json:"pid"`
	Since time.Time `json:"since"`
}

// MemStat is the memory status attached to a memstall sample.
// StallNs is the eBPF measurement (the main signal); usage and PSI come from /proc as a cross-check.
type MemStat struct {
	TotalBytes     uint64 `json:"totalBytes"`
	AvailableBytes uint64 `json:"availableBytes"`
	StallNs        uint64 `json:"stallNs"`   // Total time all processes were stalled in reclaim during the interval (eBPF)
	PsiSomeUs      uint64 `json:"psiSomeUs"` // Increase in PSI memory "some" during the interval (time at least one task was stalled)
	PsiFullUs      uint64 `json:"psiFullUs"` // Increase in PSI memory "full" during the interval (time all tasks were stalled)
}

// ProcEvent is a single process start, exit, or OOM kill.
type ProcEvent struct {
	Time time.Time `json:"time"`
	Kind string    `json:"kind"` // "exec" | "exit" | "oom" | "signal" (a terminating signal sent to Pid; Signal and Trigger* say which and by whom)
	Pid  uint32    `json:"pid"`
	Ppid uint32    `json:"ppid"`
	UID  uint32    `json:"uid"`
	Comm string    `json:"comm"`
	VM   string    `json:"vm,omitempty"` // set when the process is a VM (QEMU), so its exit can be explained as "VM <name> stopped"
	// exec
	Filename string `json:"filename,omitempty"`
	// exit
	ExitStatus int    `json:"exitStatus"` // Exit code on normal exit
	Signal     int    `json:"signal"`     // Signal number when terminated by a signal (0 means normal exit)
	CoreDump   bool   `json:"coreDump"`
	LifetimeNs uint64 `json:"lifetimeNs"`
	// oom (Pid/Comm are the process that was killed)
	TriggerPid  uint32 `json:"triggerPid,omitempty"`
	TriggerComm string `json:"triggerComm,omitempty"`
	TotalPages  uint64 `json:"totalPages,omitempty"`
	Memcg       bool   `json:"memcg"` // OOM caused by a cgroup memory limit
}

// EventBatch is the set of events the agent sends together for each interval.
type EventBatch struct {
	Host    string      `json:"host"`
	Time    time.Time   `json:"time"`
	Events  []ProcEvent `json:"events"`
	Dropped uint64      `json:"dropped"` // Number of events dropped on overflow (kernel side + agent side)
}

// ProcStat is a per-process aggregate for one interval. Processes with the same name are merged.
// The agent only sends the top processes by wait time and by CPU usage, so this is not every process.
type ProcStat struct {
	Comm      string   `json:"comm"`
	Procs     int      `json:"procs"` // Number of processes with this name
	Pids      []uint32 `json:"pids"`  // The first few PIDs
	OnCPUNs   uint64   `json:"onCpuNs"`
	WaitCount uint64   `json:"waitCount"`
	WaitNs    uint64   `json:"waitNs"`
	WaitMaxNs uint64   `json:"waitMaxNs"`
	Slots     []uint64 `json:"slots"` // log2 histogram of wait time (µs)
	// memstall only. In memstall, Wait* means "stalled in memory reclaim"
	ReclaimedPages uint64 `json:"reclaimedPages,omitempty"`
	MemcgCount     uint64 `json:"memcgCount,omitempty"` // Of those, the number of reclaims caused by a cgroup limit
	// biolat only. In biolat, Wait* means "latency of the block I/O this process issued"
	ReadBytes  uint64 `json:"readBytes,omitempty"`
	WriteBytes uint64 `json:"writeBytes,omitempty"`
	// tcpconn only. In tcpconn, Wait* means "connect latency of the connections this process opened"
	ConnectFails uint64 `json:"connectFails,omitempty"`
	// dnslat only. In dnslat, Wait* means "time spent in getaddrinfo"
	LookupFails uint64 `json:"lookupFails,omitempty"`
}

// HostInfo is used for the list of hosts known to the server.
type HostInfo struct {
	Name     string    `json:"name"`
	LastSeen time.Time `json:"lastSeen"`
	Probes   []string  `json:"probes"`
}

// Incident is one thing that went wrong, as judged by the server-side trigger rules.
// Ongoing incidents have End == nil. Instant incidents (an OOM kill, a crash) have End == Start.
type Incident struct {
	ID      string     `json:"id"` // host + kind + subject + start; stable across updates
	Host    string     `json:"host"`
	Kind    string     `json:"kind"`              // "cpu_wait" | "mem_stall" | "oom_kill" | "crash" | "crash_loop" | "agent_down" | "vm_down" | "vm_cpu_wait" | "gpu_starved" | "vram_full" | "disk_slow" | "disk_error" | "net_connect_fail" | "net_connect_slow" | "net_retrans" | "dns_fail" | "dns_slow"
	Level   string     `json:"level"`             // "caution" | "warning"
	Subject string     `json:"subject,omitempty"` // process name for oom_kill / crash / crash_loop
	Start   time.Time  `json:"start"`
	End     *time.Time `json:"end,omitempty"`
	Updated time.Time  `json:"updated"`
	Seconds int        `json:"seconds"`         // seconds the condition held (cpu_wait / mem_stall / agent_down)
	Peak    float64    `json:"peak,omitempty"`  // cpu_wait: p99 in µs; mem_stall: ms/s; crash_loop: crash count
	Count   int        `json:"count,omitempty"` // crash_loop: crashes so far
	// oom_kill / crash details
	Pid         uint32 `json:"pid,omitempty"`
	Signal      int    `json:"signal,omitempty"`
	CoreDump    bool   `json:"coreDump,omitempty"`
	Memcg       bool   `json:"memcg,omitempty"`
	TriggerComm string `json:"triggerComm,omitempty"`
	TriggerPid  uint32 `json:"triggerPid,omitempty"`
	// vm_down: why the VM stopped, and what its QEMU process went through in the minute before
	VM               string  `json:"vm,omitempty"`
	Cause            string  `json:"cause,omitempty"` // "host_oom" | "cgroup_oom" | "crash" | "killed" | "shutdown"
	ExitStatus       int     `json:"exitStatus,omitempty"`
	ContextStallMs   float64 `json:"contextStallMs,omitempty"`   // time the VM stalled in memory reclaim in the last 60 s
	ContextWaitP99Us float64 `json:"contextWaitP99Us,omitempty"` // run-queue wait p99 of the VM in the last 60 s
	// cpu_wait / vm_cpu_wait: who was using the CPU while the subject waited (the culprit group, see trigger.GroupCulprits)
	Culprits     []Culprit `json:"culprits,omitempty"`
	CulpritShare float64   `json:"culpritShare,omitempty"` // combined share of the host's CPU used by the group
	HostBusy     float64   `json:"hostBusy,omitempty"`     // share of the host's CPU that was busy over the same window
	// gpu_starved: the GPU sat idle while Subject (a CUDA process) was busy elsewhere. Peak is the busy share (0..1)
	GPUUtil   float64 `json:"gpuUtil,omitempty"`   // GPU utilization at the peak, 0..1
	CPUShare  float64 `json:"cpuShare,omitempty"`  // share of the interval the process spent on the CPU at the peak
	CopyShare float64 `json:"copyShare,omitempty"` // share of the interval it spent inside copy calls at the peak
	// vram_full: Peak is the share of VRAM in use (0..1)
	// disk_slow: Peak is the latency p99 in µs; Culprits are the processes that issued most of the bytes over the window
	// disk_error: Subject is the device, Count the failed I/Os in that second
	Device string `json:"device,omitempty"`
	// net_connect_fail / net_retrans: Peak is the rate per second; Culprits are the destinations ("addr:port") that took most of it.
	// net_connect_slow: Peak is the connect latency p99 in µs; Culprits are the destinations with the slowest connects
	// dns_fail: Peak is failed lookups in the last 10 s; Culprits are the names. dns_slow: Peak is the lookup p99 in µs
}

// Culprit is one member of the group that was using the CPU while an incident's subject waited.
// Name is a process name, or "vm:<name>" for a VM.
type Culprit struct {
	Name  string  `json:"name"`
	Share float64 `json:"share"` // of the host's total CPU capacity, 0..1
}

// Ongoing reports whether the incident is still open.
func (i Incident) Ongoing() bool { return i.End == nil }
