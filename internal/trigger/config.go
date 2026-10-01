// Package trigger judges samples and events on the server and turns them into incidents.
// The rules are deterministic and every verdict can be traced back to the numbers that caused it (see docs/adr/0001).
package trigger

import (
	"encoding/json"
	"fmt"
	"os"
)

// Config holds every threshold and window the rules use. It is served at GET /api/triggers so the UI draws
// its threshold bands from the same numbers the server judges with.
type Config struct {
	CPU       ExcursionRule `json:"cpu"`       // run-queue latency p99, in µs
	Memory    ExcursionRule `json:"memory"`    // time stalled in reclaim, in ms per second
	Processes ProcessRule   `json:"processes"` // crashes and OOM kills
	AgentDown AgentDownRule `json:"agentDown"` // a host that stopped reporting
	GPU       GPURule       `json:"gpu"`       // a GPU sitting idle while its process works elsewhere, and VRAM running out
	Disk      ExcursionRule `json:"disk"`      // block I/O latency p99, in µs
	Network   NetworkRule   `json:"network"`   // outbound TCP: failed connects, slow connects, retransmissions
	DNS       DNSRule       `json:"dns"`       // name resolution (glibc getaddrinfo): failed and slow lookups
	Files     FilesRule     `json:"files"`     // failed opens (EACCES, EROFS, ENOSPC...) and slow fsync
	Locks     ExcursionRule `json:"locks"`     // a process's lock wait, in seconds per second (threads' worth blocked on locks)
}

// FilesRule: Fails is the number of trouble-tier failed opens (see internal/fileerr: permission denied, read-only
// file system, no space, too many open files...) in the last 10 s; ENOENT never counts. FsyncLatency is the fsync
// p99 in µs: an SSD syncs in about a millisecond, an HDD in ten; 100 ms is a queue, a second is a stalled disk.
type FilesRule struct {
	Fails             ExcursionRule `json:"fails"`
	FailSpreadSeconds int           `json:"failSpreadSeconds"` // as for NetworkRule
	FsyncLatency      ExcursionRule `json:"fsyncLatency"`
}

// DNSRule: Fails is the number of failed lookups in the last 10 s (a burst of NXDOMAINs lasts one second);
// Latency is the getaddrinfo p99 in µs. A p99 at seconds is a resolver that does not answer and gets retried.
type DNSRule struct {
	Fails             ExcursionRule `json:"fails"`
	FailSpreadSeconds int           `json:"failSpreadSeconds"` // as for NetworkRule
	Latency           ExcursionRule `json:"latency"`
}

// NetworkRule: ConnectFails is the number of failed connects in the last 10 s (a burst of refused connects lasts
// one second and is still an incident); Retrans is a rate per second; ConnectLatency is the connect p99 in µs.
// A connect p99 at 1 s means the SYN itself was retransmitted (the initial RTO), i.e. packets to that destination
// are being lost, so the warning sits there. Drops is the number of packets the kernel dropped for a trouble
// reason (a full accept queue, a firewall rule, no route, no memory: see internal/netdrop) in the last 10 s;
// housekeeping drops (duplicates, stale segments) never count.
type NetworkRule struct {
	ConnectFails      ExcursionRule `json:"connectFails"`
	FailSpreadSeconds int           `json:"failSpreadSeconds"` // failures (and drops) must fall in at least this many of the 10 s (a one-second burst is not an outage)
	ConnectLatency    ExcursionRule `json:"connectLatency"`
	Retrans           ExcursionRule `json:"retrans"`
	Drops             ExcursionRule `json:"drops"`
}

// GPURule: the GPU is "starved" when its utilization is below IdleUtil while a CUDA process is busy on the CPU
// or inside copy calls (Starved judges that busy share, 0..1: the process is working, just not on the GPU).
// VRAM judges the share of VRAM in use (0..1); a CUDA allocation that fails kills the job, so this is an early warning.
type GPURule struct {
	IdleUtil float64       `json:"idleUtil"`
	Starved  ExcursionRule `json:"starved"`
	VRAM     ExcursionRule `json:"vram"`
}

// ExcursionRule describes "a value stayed above a threshold for a while".
// A single second over the threshold is noise; the incident opens only after MinSeconds and closes only after
// the value has been back below the threshold for more than MaxGapSeconds.
type ExcursionRule struct {
	Caution       float64 `json:"caution"`
	Warning       float64 `json:"warning"`
	MinSeconds    int     `json:"minSeconds"`
	MaxGapSeconds int     `json:"maxGapSeconds"`
}

// ProcessRule: a crash is a caution, an OOM kill is a warning, and the same command crashing
// CrashLoopCount times within CrashLoopWindowSeconds is a warning (a crash loop).
type ProcessRule struct {
	CrashLoopCount         int `json:"crashLoopCount"`
	CrashLoopWindowSeconds int `json:"crashLoopWindowSeconds"`
}

// AgentDownRule: a host is "down" (as far as we can tell) after AfterSeconds without any sample.
type AgentDownRule struct {
	AfterSeconds int `json:"afterSeconds"`
}

// Default returns the provisional thresholds. They were chosen from measurements on the test machine:
// the per-second CPU p99 is about 30 µs idle and 16 ms under 4x oversubscription; reclaim stalls are 0 idle
// and about 11 ms/s with four dd processes fighting a 32 MB cgroup.
func Default() Config {
	return Config{
		CPU:       ExcursionRule{Caution: 1_000, Warning: 10_000, MinSeconds: 3, MaxGapSeconds: 2},
		Memory:    ExcursionRule{Caution: 10, Warning: 100, MinSeconds: 3, MaxGapSeconds: 2},
		Processes: ProcessRule{CrashLoopCount: 3, CrashLoopWindowSeconds: 300},
		AgentDown: AgentDownRule{AfterSeconds: 30},
		// GPU work is bursty (a model loads, a batch is prepared), so a starved GPU must persist 10 s before it
		// counts, and 5 s of GPU activity ends it. Warning means the process is fully busy elsewhere
		GPU: GPURule{
			IdleUtil: 0.2,
			Starved:  ExcursionRule{Caution: 0.5, Warning: 0.9, MinSeconds: 10, MaxGapSeconds: 5},
			VRAM:     ExcursionRule{Caution: 0.90, Warning: 0.97, MinSeconds: 3, MaxGapSeconds: 2},
		},
		// An SSD completes most I/O under 1 ms and an HDD under 20 ms; p99 at 10 ms is a queue building up on an
		// SSD and normal on a busy HDD (tune per host). 100 ms is slow for anything
		Disk: ExcursionRule{Caution: 10_000, Warning: 100_000, MinSeconds: 3, MaxGapSeconds: 2},
		Network: NetworkRule{
			ConnectFails: ExcursionRule{Caution: 5, Warning: 50, MinSeconds: 1, MaxGapSeconds: 10},
			// Measured on the test host: NetworkManager's connectivity check fails 12 IPv6 connects within one second
			// every 5 minutes (no IPv6 route) — 103 of 118 incidents in a day before this rule. A down dependency fails
			// second after second, so 3 of 10 seconds separates the two
			FailSpreadSeconds: 3,
			ConnectLatency:    ExcursionRule{Caution: 200_000, Warning: 1_000_000, MinSeconds: 3, MaxGapSeconds: 5},
			Retrans:           ExcursionRule{Caution: 10, Warning: 100, MinSeconds: 3, MaxGapSeconds: 5},
			// Idle, the test host drops nothing for a trouble reason (IPV6DISABLED aside: 14 in 30 s from avahi on a
			// host without IPv6, which is why that one is judged like the rest and not on its own). A full accept
			// queue or a firewall rule drops every packet of every attempt, so 10 in 10 s is already a real problem
			Drops: ExcursionRule{Caution: 10, Warning: 100, MinSeconds: 1, MaxGapSeconds: 10},
		},
		// An answer from the local stub (systemd-resolved) takes ~1 ms and one from upstream ~10-50 ms; 100 ms is slow,
		// and 1 s is a server that did not answer and was retried
		DNS: DNSRule{
			Fails:             ExcursionRule{Caution: 5, Warning: 50, MinSeconds: 1, MaxGapSeconds: 10},
			FailSpreadSeconds: 3,
			Latency:           ExcursionRule{Caution: 100_000, Warning: 1_000_000, MinSeconds: 3, MaxGapSeconds: 5},
		},
		// Idle, the test host fails no open for a trouble reason outside /proc (lsof's EACCES on other users'
		// /proc/<pid>/fd is filed as noise). A service denied its key, or a disk gone read-only, fails on every try
		Files: FilesRule{
			Fails:             ExcursionRule{Caution: 5, Warning: 50, MinSeconds: 1, MaxGapSeconds: 10},
			FailSpreadSeconds: 3,
			FsyncLatency:      ExcursionRule{Caution: 100_000, Warning: 1_000_000, MinSeconds: 3, MaxGapSeconds: 5},
		},
		// Lock wait is summed over a process's threads: 1.0 means one thread's worth of time blocked on locks
		// the whole second (measured: 8 threads fighting one mutex → 7.0; idle Go services → 0, their parked
		// threads are told apart by address). Caution at one thread, warning at four
		Locks: ExcursionRule{Caution: 1.0, Warning: 4.0, MinSeconds: 3, MaxGapSeconds: 2},
	}
}

// Load reads a JSON file over the defaults, so a file only needs the values it changes.
func Load(path string) (Config, error) {
	cfg := Default()
	b, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return cfg, fmt.Errorf("parse %s: %w", path, err)
	}
	return cfg, cfg.Validate()
}

// Validate rejects values that would make the rules meaningless (e.g. warning below caution).
func (c Config) Validate() error {
	for name, n := range map[string]int{"network.failSpreadSeconds": c.Network.FailSpreadSeconds, "dns.failSpreadSeconds": c.DNS.FailSpreadSeconds, "files.failSpreadSeconds": c.Files.FailSpreadSeconds} {
		if n < 1 || n > 10 {
			return fmt.Errorf("%s must be between 1 and 10 (the window is 10 s)", name)
		}
	}
	if c.GPU.IdleUtil <= 0 || c.GPU.IdleUtil > 1 {
		return fmt.Errorf("gpu: idleUtil must be in (0, 1]")
	}
	for name, r := range map[string]ExcursionRule{"cpu": c.CPU, "memory": c.Memory, "gpu.starved": c.GPU.Starved, "gpu.vram": c.GPU.VRAM, "disk": c.Disk, "network.connectFails": c.Network.ConnectFails, "network.connectLatency": c.Network.ConnectLatency, "network.retrans": c.Network.Retrans, "network.drops": c.Network.Drops, "dns.fails": c.DNS.Fails, "dns.latency": c.DNS.Latency, "files.fails": c.Files.Fails, "files.fsyncLatency": c.Files.FsyncLatency, "locks": c.Locks} {
		switch {
		case r.Caution <= 0 || r.Warning <= 0:
			return fmt.Errorf("%s: thresholds must be positive", name)
		case r.Warning < r.Caution:
			return fmt.Errorf("%s: warning (%v) must not be below caution (%v)", name, r.Warning, r.Caution)
		case r.MinSeconds < 1:
			return fmt.Errorf("%s: minSeconds must be at least 1", name)
		case r.MaxGapSeconds < 0:
			return fmt.Errorf("%s: maxGapSeconds must not be negative", name)
		}
	}
	if c.Processes.CrashLoopCount < 2 {
		return fmt.Errorf("processes: crashLoopCount must be at least 2")
	}
	if c.Processes.CrashLoopWindowSeconds < 1 {
		return fmt.Errorf("processes: crashLoopWindowSeconds must be at least 1")
	}
	if c.AgentDown.AfterSeconds < 5 {
		return fmt.Errorf("agentDown: afterSeconds must be at least 5")
	}
	return nil
}
