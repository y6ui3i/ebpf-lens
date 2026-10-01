// Package history folds per-second samples into coarser buckets for the history screen. A bucket is itself a
// model.Sample, so the UI's helpers (percentile of Slots, ms/s from StallNs over IntervalMs, …) work unchanged:
// histograms are summed (the p99 of a bucket is the p99 over every event in it), counters and durations are summed
// along with IntervalMs (so rates come out as averages), and gauges take the last or the peak value.
package history

import (
	"sort"
	"time"

	"github.com/y6ui3i/ebpf-lens/internal/model"
)

// maxRows bounds the per-bucket lists (destinations, names, processes), the same way the agent bounds a sample.
const maxRows = 20

// Aggregate folds samples (one host, one probe, in time order) into buckets of the given width, aligned to it.
// A bucket width of zero or less returns the samples unchanged.
func Aggregate(xs []model.Sample, bucket time.Duration) []model.Sample {
	if bucket <= time.Second || len(xs) == 0 {
		return xs
	}
	var out []model.Sample
	var cur *model.Sample
	var n int
	var start time.Time
	flush := func() {
		if cur != nil {
			finish(cur, n)
			out = append(out, *cur)
		}
	}
	for _, x := range xs {
		b := x.Time.Truncate(bucket)
		if cur == nil || !b.Equal(start) {
			flush()
			start = b
			c := clone(x)
			c.Time = b.Add(bucket) // a bucket is stamped at its end, like a sample is stamped when its interval ends
			cur, n = &c, 1
			continue
		}
		merge(cur, x)
		n++
	}
	flush()
	return out
}

func clone(x model.Sample) model.Sample {
	c := x
	c.Slots = append([]uint64(nil), x.Slots...)
	c.Procs = append([]model.ProcStat(nil), x.Procs...)
	for i := range c.Procs {
		c.Procs[i].Slots = append([]uint64(nil), x.Procs[i].Slots...)
		c.Procs[i].Pids = nil
	}
	if x.Mem != nil {
		m := *x.Mem
		c.Mem = &m
	}
	if x.GPU != nil {
		g := *x.GPU
		g.Procs = nil
		c.GPU = &g
	}
	if x.Disk != nil {
		c.Disk = &model.DiskStat{Devices: append([]model.DiskDev(nil), x.Disk.Devices...)}
		for i := range c.Disk.Devices {
			c.Disk.Devices[i].Slots = append([]uint64(nil), x.Disk.Devices[i].Slots...)
		}
	}
	if x.Net != nil {
		c.Net = &model.NetStat{
			Dests:     append([]model.NetDest(nil), x.Net.Dests...),
			Drops:     append([]model.NetDrop(nil), x.Net.Drops...),
			DropFlows: append([]model.NetDropFlow(nil), x.Net.DropFlows...),
		}
	}
	if x.DNS != nil {
		c.DNS = &model.DNSStat{Names: append([]model.DNSName(nil), x.DNS.Names...)}
	}
	if x.Lock != nil {
		l := *x.Lock
		l.Kernel = append([]model.KernelLock(nil), x.Lock.Kernel...)
		c.Lock = &l
	}
	if x.Files != nil {
		c.Files = &model.FileStat{
			OpenErrs:  append([]model.FileOpenErr(nil), x.Files.OpenErrs...),
			OpenFails: append([]model.FileOpenFail(nil), x.Files.OpenFails...),
			Fsyncs:    append([]model.FileSync(nil), x.Files.Fsyncs...),
		}
	}
	return c
}

func addSlots(dst *[]uint64, src []uint64) {
	for len(*dst) < len(src) {
		*dst = append(*dst, 0)
	}
	for i, v := range src {
		(*dst)[i] += v
	}
}

func merge(c *model.Sample, x model.Sample) {
	addSlots(&c.Slots, x.Slots)
	c.IntervalMs += x.IntervalMs
	c.BusyNs += x.BusyNs
	c.CPUs = max(c.CPUs, x.CPUs)
	if len(x.VMs) > 0 || x.Probe == "vms" {
		c.VMs = x.VMs // the VMs that ran at the end of the bucket
	}
	mergeProcs(c, x.Procs)
	if x.Mem != nil {
		if c.Mem == nil {
			c.Mem = &model.MemStat{}
		}
		c.Mem.StallNs += x.Mem.StallNs
		c.Mem.PsiSomeUs += x.Mem.PsiSomeUs
		c.Mem.PsiFullUs += x.Mem.PsiFullUs
		c.Mem.TotalBytes, c.Mem.AvailableBytes = x.Mem.TotalBytes, x.Mem.AvailableBytes
	}
	if x.GPU != nil {
		if c.GPU == nil {
			g := *x.GPU
			g.Procs = nil
			c.GPU = &g
		} else {
			// Utilization is summed here and divided by the sample count in finish (an average over the bucket)
			c.GPU.Util += x.GPU.Util
			c.GPU.MemUtil += x.GPU.MemUtil
			c.GPU.PowerW += x.GPU.PowerW
			c.GPU.UsedBytes = max(c.GPU.UsedBytes, x.GPU.UsedBytes) // VRAM: the peak, since running out is the risk
			c.GPU.TotalBytes = x.GPU.TotalBytes
			c.GPU.TempC = max(c.GPU.TempC, x.GPU.TempC)
			for _, r := range x.GPU.Throttle {
				if !contains(c.GPU.Throttle, r) {
					c.GPU.Throttle = append(c.GPU.Throttle, r)
				}
			}
		}
	}
	if x.Disk != nil {
		if c.Disk == nil {
			c.Disk = &model.DiskStat{}
		}
		for _, d := range x.Disk.Devices {
			i := indexOf(len(c.Disk.Devices), func(i int) bool { return c.Disk.Devices[i].Name == d.Name })
			if i < 0 {
				d.Slots = append([]uint64(nil), d.Slots...)
				c.Disk.Devices = append(c.Disk.Devices, d)
				continue
			}
			t := &c.Disk.Devices[i]
			t.Reads += d.Reads
			t.Writes += d.Writes
			t.ReadBytes += d.ReadBytes
			t.WriteBytes += d.WriteBytes
			t.Errors += d.Errors
			t.LatNs += d.LatNs
			t.LatMaxNs = max(t.LatMaxNs, d.LatMaxNs)
			addSlots(&t.Slots, d.Slots)
		}
	}
	if x.Net != nil {
		if c.Net == nil {
			c.Net = &model.NetStat{}
		}
		for _, d := range x.Net.Dests {
			i := indexOf(len(c.Net.Dests), func(i int) bool { return c.Net.Dests[i].Addr == d.Addr && c.Net.Dests[i].Port == d.Port })
			if i < 0 {
				c.Net.Dests = append(c.Net.Dests, d)
				continue
			}
			t := &c.Net.Dests[i]
			t.Connects += d.Connects
			t.Fails += d.Fails
			t.Retrans += d.Retrans
			t.LatNs += d.LatNs
			t.LatMaxNs = max(t.LatMaxNs, d.LatMaxNs)
		}
		for _, d := range x.Net.Drops {
			i := indexOf(len(c.Net.Drops), func(i int) bool { return c.Net.Drops[i].Reason == d.Reason })
			if i < 0 {
				c.Net.Drops = append(c.Net.Drops, d)
				continue
			}
			c.Net.Drops[i].Count += d.Count
		}
		for _, f := range x.Net.DropFlows {
			i := indexOf(len(c.Net.DropFlows), func(i int) bool {
				g := c.Net.DropFlows[i]
				return g.Reason == f.Reason && g.Src == f.Src && g.Dst == f.Dst && g.Dport == f.Dport && g.Proto == f.Proto
			})
			if i < 0 {
				c.Net.DropFlows = append(c.Net.DropFlows, f)
				continue
			}
			c.Net.DropFlows[i].Count += f.Count
			if f.Listener != "" {
				c.Net.DropFlows[i].Listener = f.Listener
			}
		}
	}
	if x.DNS != nil {
		if c.DNS == nil {
			c.DNS = &model.DNSStat{}
		}
		for _, d := range x.DNS.Names {
			i := indexOf(len(c.DNS.Names), func(i int) bool { return c.DNS.Names[i].Name == d.Name })
			if i < 0 {
				c.DNS.Names = append(c.DNS.Names, d)
				continue
			}
			t := &c.DNS.Names[i]
			t.Lookups += d.Lookups
			t.Fails += d.Fails
			t.LatNs += d.LatNs
			t.LatMaxNs = max(t.LatMaxNs, d.LatMaxNs)
			if d.LastError != "" {
				t.LastError = d.LastError
			}
		}
	}
	if x.Lock != nil {
		if c.Lock == nil {
			c.Lock = &model.LockStat{}
		}
		c.Lock.UserWaits += x.Lock.UserWaits
		c.Lock.UserNs += x.Lock.UserNs
		c.Lock.ParkedNs += x.Lock.ParkedNs
		for _, k := range x.Lock.Kernel {
			i := indexOf(len(c.Lock.Kernel), func(i int) bool { return c.Lock.Kernel[i].Kind == k.Kind })
			if i < 0 {
				c.Lock.Kernel = append(c.Lock.Kernel, k)
				continue
			}
			c.Lock.Kernel[i].Count += k.Count
			c.Lock.Kernel[i].LatNs += k.LatNs
		}
	}
	if x.Files != nil {
		if c.Files == nil {
			c.Files = &model.FileStat{}
		}
		for _, e := range x.Files.OpenErrs {
			i := indexOf(len(c.Files.OpenErrs), func(i int) bool { return c.Files.OpenErrs[i].Error == e.Error })
			if i < 0 {
				c.Files.OpenErrs = append(c.Files.OpenErrs, e)
				continue
			}
			c.Files.OpenErrs[i].Count += e.Count
		}
		for _, f := range x.Files.OpenFails {
			i := indexOf(len(c.Files.OpenFails), func(i int) bool {
				g := c.Files.OpenFails[i]
				return g.Comm == f.Comm && g.Path == f.Path && g.Error == f.Error
			})
			if i < 0 {
				c.Files.OpenFails = append(c.Files.OpenFails, f)
				continue
			}
			c.Files.OpenFails[i].Count += f.Count
		}
		for _, f := range x.Files.Fsyncs {
			i := indexOf(len(c.Files.Fsyncs), func(i int) bool { return c.Files.Fsyncs[i].Name == f.Name })
			if i < 0 {
				c.Files.Fsyncs = append(c.Files.Fsyncs, f)
				continue
			}
			t := &c.Files.Fsyncs[i]
			t.Fsyncs += f.Fsyncs
			t.LatNs += f.LatNs
			t.LatMaxNs = max(t.LatMaxNs, f.LatMaxNs)
		}
	}
}

func mergeProcs(c *model.Sample, ps []model.ProcStat) {
	for _, p := range ps {
		i := indexOf(len(c.Procs), func(i int) bool { return c.Procs[i].Comm == p.Comm })
		if i < 0 {
			p.Slots = append([]uint64(nil), p.Slots...)
			p.Pids = nil
			c.Procs = append(c.Procs, p)
			continue
		}
		t := &c.Procs[i]
		t.Procs = max(t.Procs, p.Procs)
		t.OnCPUNs += p.OnCPUNs
		t.WaitCount += p.WaitCount
		t.WaitNs += p.WaitNs
		t.WaitMaxNs = max(t.WaitMaxNs, p.WaitMaxNs)
		t.ReclaimedPages += p.ReclaimedPages
		t.MemcgCount += p.MemcgCount
		t.ReadBytes += p.ReadBytes
		t.WriteBytes += p.WriteBytes
		t.ConnectFails += p.ConnectFails
		t.LookupFails += p.LookupFails
		t.OpenFails += p.OpenFails
		t.Locks = max(t.Locks, p.Locks)
		t.KernelLockCount += p.KernelLockCount
		t.KernelLockNs += p.KernelLockNs
		addSlots(&t.Slots, p.Slots)
	}
}

// finish turns the GPU sums into averages and trims the lists to the rows that matter most.
func finish(c *model.Sample, n int) {
	if c.GPU != nil && n > 1 {
		c.GPU.Util /= float64(n)
		c.GPU.MemUtil /= float64(n)
		c.GPU.PowerW /= float64(n)
	}
	if len(c.Procs) > maxRows {
		sort.Slice(c.Procs, func(i, j int) bool {
			a, b := c.Procs[i], c.Procs[j]
			return a.OnCPUNs+a.WaitNs > b.OnCPUNs+b.WaitNs
		})
		c.Procs = c.Procs[:maxRows]
	}
	if c.Net != nil && len(c.Net.Dests) > maxRows {
		sort.Slice(c.Net.Dests, func(i, j int) bool {
			a, b := c.Net.Dests[i], c.Net.Dests[j]
			return a.Fails*4+a.Retrans+a.Connects > b.Fails*4+b.Retrans+b.Connects
		})
		c.Net.Dests = c.Net.Dests[:maxRows]
	}
	if c.Net != nil && len(c.Net.DropFlows) > maxRows {
		sort.Slice(c.Net.DropFlows, func(i, j int) bool { return c.Net.DropFlows[i].Count > c.Net.DropFlows[j].Count })
		c.Net.DropFlows = c.Net.DropFlows[:maxRows]
	}
	if c.Files != nil && len(c.Files.OpenFails) > maxRows {
		sort.Slice(c.Files.OpenFails, func(i, j int) bool { return c.Files.OpenFails[i].Count > c.Files.OpenFails[j].Count })
		c.Files.OpenFails = c.Files.OpenFails[:maxRows]
	}
	if c.Files != nil && len(c.Files.Fsyncs) > maxRows {
		sort.Slice(c.Files.Fsyncs, func(i, j int) bool { return c.Files.Fsyncs[i].LatNs > c.Files.Fsyncs[j].LatNs })
		c.Files.Fsyncs = c.Files.Fsyncs[:maxRows]
	}
	if c.DNS != nil && len(c.DNS.Names) > maxRows {
		sort.Slice(c.DNS.Names, func(i, j int) bool {
			a, b := c.DNS.Names[i], c.DNS.Names[j]
			return a.Fails*4+a.Lookups > b.Fails*4+b.Lookups
		})
		c.DNS.Names = c.DNS.Names[:maxRows]
	}
}

func indexOf(n int, f func(int) bool) int {
	for i := 0; i < n; i++ {
		if f(i) {
			return i
		}
	}
	return -1
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}
