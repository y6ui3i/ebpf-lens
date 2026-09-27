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
}

// NetworkRule: ConnectFails is the number of failed connects in the last 10 s (a burst of refused connects lasts
// one second and is still an incident); Retrans is a rate per second; ConnectLatency is the connect p99 in µs.
// A connect p99 at 1 s means the SYN itself was retransmitted (the initial RTO), i.e. packets to that destination
// are being lost, so the warning sits there.
type NetworkRule struct {
	ConnectFails   ExcursionRule `json:"connectFails"`
	ConnectLatency ExcursionRule `json:"connectLatency"`
	Retrans        ExcursionRule `json:"retrans"`
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
			ConnectFails:   ExcursionRule{Caution: 5, Warning: 50, MinSeconds: 1, MaxGapSeconds: 10},
			ConnectLatency: ExcursionRule{Caution: 200_000, Warning: 1_000_000, MinSeconds: 3, MaxGapSeconds: 5},
			Retrans:        ExcursionRule{Caution: 10, Warning: 100, MinSeconds: 3, MaxGapSeconds: 5},
		},
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
	if c.GPU.IdleUtil <= 0 || c.GPU.IdleUtil > 1 {
		return fmt.Errorf("gpu: idleUtil must be in (0, 1]")
	}
	for name, r := range map[string]ExcursionRule{"cpu": c.CPU, "memory": c.Memory, "gpu.starved": c.GPU.Starved, "gpu.vram": c.GPU.VRAM, "disk": c.Disk, "network.connectFails": c.Network.ConnectFails, "network.connectLatency": c.Network.ConnectLatency, "network.retrans": c.Network.Retrans} {
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
