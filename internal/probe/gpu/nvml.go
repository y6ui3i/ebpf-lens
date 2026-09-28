package gpu

import (
	"fmt"

	"github.com/NVIDIA/go-nvml/pkg/nvml"

	"github.com/y6ui3i/ebpf-lens/internal/model"
)

// NVML reads the first GPU's own counters through the driver's management library. go-nvml opens
// libnvidia-ml.so.1 at run time, so the agent builds and runs on hosts without a GPU; Open just fails there.
type NVML struct {
	dev  nvml.Device
	name string
}

// OpenNVML initialises NVML and picks GPU 0. It fails on a host without an NVIDIA driver, which the agent treats
// as "no GPU to watch" rather than an error.
func OpenNVML() (*NVML, error) {
	if r := nvml.Init(); r != nvml.SUCCESS {
		return nil, fmt.Errorf("nvml init: %s", nvml.ErrorString(r))
	}
	n, r := nvml.DeviceGetCount()
	if r != nvml.SUCCESS || n == 0 {
		nvml.Shutdown()
		return nil, fmt.Errorf("no NVIDIA GPU (%s)", nvml.ErrorString(r))
	}
	dev, r := nvml.DeviceGetHandleByIndex(0)
	if r != nvml.SUCCESS {
		nvml.Shutdown()
		return nil, fmt.Errorf("nvml device 0: %s", nvml.ErrorString(r))
	}
	name, _ := dev.GetName()
	return &NVML{dev: dev, name: name}, nil
}

// Name is the GPU's product name.
func (n *NVML) Name() string { return n.name }

// Read fills the GPU-wide fields of a GPUStat and returns the VRAM each process holds, by pid.
// Each call takes about 15 ms on an RTX 2070, which is fine once a second.
func (n *NVML) Read() (model.GPUStat, map[uint32]uint64) {
	g := model.GPUStat{Name: n.name}
	if u, r := n.dev.GetUtilizationRates(); r == nvml.SUCCESS {
		g.Util, g.MemUtil = float64(u.Gpu)/100, float64(u.Memory)/100
	}
	if m, r := n.dev.GetMemoryInfo(); r == nvml.SUCCESS {
		g.UsedBytes, g.TotalBytes = m.Used, m.Total
	}
	if t, r := n.dev.GetTemperature(nvml.TEMPERATURE_GPU); r == nvml.SUCCESS {
		g.TempC = int(t)
	}
	if p, r := n.dev.GetPowerUsage(); r == nvml.SUCCESS {
		g.PowerW = float64(p) / 1000
	}
	g.Throttle = throttleReasons(n.dev)
	vram := map[uint32]uint64{}
	if procs, r := n.dev.GetComputeRunningProcesses(); r == nvml.SUCCESS {
		for _, p := range procs {
			vram[p.Pid] += p.UsedGpuMemory
		}
	}
	return g, vram
}

// throttleReasons names why the clocks are held back, leaving out "idle" and "application setting" (not problems).
func throttleReasons(dev nvml.Device) []string {
	bits, r := dev.GetCurrentClocksEventReasons()
	if r != nvml.SUCCESS {
		return nil
	}
	var out []string
	for _, x := range []struct {
		mask uint64
		name string
	}{
		// go-nvml keeps the older "Throttle" spelling for some of these bits
		{nvml.ClocksEventReasonSwPowerCap, "power"},
		{nvml.ClocksEventReasonSwThermalSlowdown, "thermal"},
		{nvml.ClocksThrottleReasonHwThermalSlowdown, "thermal"},
		{nvml.ClocksThrottleReasonHwPowerBrakeSlowdown, "power"},
		{nvml.ClocksThrottleReasonHwSlowdown, "hw"},
		{nvml.ClocksEventReasonSyncBoost, "sync_boost"},
		{nvml.ClocksEventReasonDisplayClockSetting, "display"},
	} {
		if bits&x.mask != 0 && !contains(out, x.name) {
			out = append(out, x.name)
		}
	}
	return out
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// Close shuts NVML down.
func (n *NVML) Close() error {
	if r := nvml.Shutdown(); r != nvml.SUCCESS {
		return fmt.Errorf("nvml shutdown: %s", nvml.ErrorString(r))
	}
	return nil
}
