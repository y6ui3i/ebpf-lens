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
	Mem        *MemStat   `json:"mem,omitempty"` // memstall only
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
	Kind string    `json:"kind"` // "exec" | "exit" | "oom"
	Pid  uint32    `json:"pid"`
	Ppid uint32    `json:"ppid"`
	UID  uint32    `json:"uid"`
	Comm string    `json:"comm"`
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
	Kind    string     `json:"kind"`              // "cpu_wait" | "mem_stall" | "oom_kill" | "crash" | "crash_loop" | "agent_down"
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
}

// Ongoing reports whether the incident is still open.
func (i Incident) Ongoing() bool { return i.End == nil }
