package history

import (
	"testing"
	"time"

	"github.com/y6ui3i/ebpf-lens/internal/model"
)

var t0 = time.Date(2026, 9, 28, 3, 0, 0, 0, time.UTC)

func sec(i int) time.Time { return t0.Add(time.Duration(i) * time.Second) }

// Sixty seconds of runqlat fold into one bucket: histograms add up, so the bucket's p99 is the p99 over every wait
// in the minute; busy time and interval add up, so CPU utilization comes out as the minute's average.
func TestRunqlatMinuteBucket(t *testing.T) {
	var xs []model.Sample
	for i := 0; i < 60; i++ {
		slots := make([]uint64, 27)
		slots[3] = 10
		if i == 30 {
			slots[13] = 5 // one bad second
		}
		xs = append(xs, model.Sample{Probe: "runqlat", Time: sec(i), IntervalMs: 1000, CPUs: 8, BusyNs: 4e9, Slots: slots,
			Procs: []model.ProcStat{{Comm: "stress", OnCPUNs: 4e9, Slots: make([]uint64, 27)}}})
	}
	out := Aggregate(xs, time.Minute)
	if len(out) != 1 {
		t.Fatalf("want one bucket, got %d", len(out))
	}
	b := out[0]
	if b.Slots[3] != 600 || b.Slots[13] != 5 || b.IntervalMs != 60_000 || b.BusyNs != 240e9 || b.CPUs != 8 {
		t.Fatalf("bucket: slots3=%d slots13=%d interval=%d busy=%d cpus=%d", b.Slots[3], b.Slots[13], b.IntervalMs, b.BusyNs, b.CPUs)
	}
	if !b.Time.Equal(t0.Add(time.Minute)) {
		t.Fatalf("a bucket is stamped at its end: %v", b.Time)
	}
	if len(b.Procs) != 1 || b.Procs[0].OnCPUNs != 240e9 {
		t.Fatalf("procs: %+v", b.Procs)
	}
	// The input must not be modified by the merge
	if xs[0].Slots[3] != 10 || xs[0].Procs[0].OnCPUNs != 4e9 {
		t.Fatalf("input changed: %+v", xs[0].Slots[:4])
	}
}

func TestGpuAveragesAndPeaks(t *testing.T) {
	xs := []model.Sample{
		{Probe: "gpu", Time: sec(0), IntervalMs: 1000, Slots: []uint64{0}, GPU: &model.GPUStat{Util: 0.2, UsedBytes: 2 << 30, TotalBytes: 8 << 30, TempC: 60}},
		{Probe: "gpu", Time: sec(1), IntervalMs: 1000, Slots: []uint64{0}, GPU: &model.GPUStat{Util: 0.8, UsedBytes: 7 << 30, TotalBytes: 8 << 30, TempC: 83, Throttle: []string{"thermal"}}},
	}
	b := Aggregate(xs, time.Minute)[0]
	if b.GPU.Util < 0.49 || b.GPU.Util > 0.51 || b.GPU.UsedBytes != 7<<30 || b.GPU.TempC != 83 || len(b.GPU.Throttle) != 1 {
		t.Fatalf("gpu bucket: %+v", b.GPU)
	}
}

func TestDestinationsAndNamesMergeByKey(t *testing.T) {
	xs := []model.Sample{
		{Probe: "tcpconn", Time: sec(0), Slots: []uint64{0}, Net: &model.NetStat{Dests: []model.NetDest{{Addr: "10.0.0.5", Port: 5432, Fails: 3}}}},
		{Probe: "tcpconn", Time: sec(1), Slots: []uint64{0}, Net: &model.NetStat{Dests: []model.NetDest{{Addr: "10.0.0.5", Port: 5432, Fails: 2}, {Addr: "10.0.0.9", Port: 443, Connects: 1}}}},
	}
	b := Aggregate(xs, time.Minute)[0]
	if len(b.Net.Dests) != 2 || b.Net.Dests[0].Fails != 5 {
		t.Fatalf("dests: %+v", b.Net.Dests)
	}
	zs := []model.Sample{
		{Probe: "tcpconn", Time: sec(0), Slots: []uint64{0}, Net: &model.NetStat{Drops: []model.NetDrop{{Reason: "TCP_LISTEN_OVERFLOW", Count: 3, Tier: "trouble"}},
			DropFlows: []model.NetDropFlow{{Reason: "TCP_LISTEN_OVERFLOW", Proto: "tcp", Src: "10.0.0.4", Dst: "10.0.0.5", Dport: 8080, Count: 3}}}},
		{Probe: "tcpconn", Time: sec(1), Slots: []uint64{0}, Net: &model.NetStat{Drops: []model.NetDrop{{Reason: "TCP_LISTEN_OVERFLOW", Count: 2, Tier: "trouble"}, {Reason: "TCP_OLD_DATA", Count: 9, Tier: "noise"}},
			DropFlows: []model.NetDropFlow{{Reason: "TCP_LISTEN_OVERFLOW", Proto: "tcp", Src: "10.0.0.4", Dst: "10.0.0.5", Dport: 8080, Count: 2, Listener: "python3"}}}},
	}
	d := Aggregate(zs, time.Minute)[0]
	if len(d.Net.Drops) != 2 || d.Net.Drops[0].Count != 5 || len(d.Net.DropFlows) != 1 || d.Net.DropFlows[0].Count != 5 || d.Net.DropFlows[0].Listener != "python3" {
		t.Fatalf("drops: %+v flows: %+v", d.Net.Drops, d.Net.DropFlows)
	}
	ys := []model.Sample{
		{Probe: "dnslat", Time: sec(0), Slots: []uint64{0}, DNS: &model.DNSStat{Names: []model.DNSName{{Name: "db.internal", Lookups: 2, Fails: 2, LastError: "NONAME"}}}},
		{Probe: "dnslat", Time: sec(5), Slots: []uint64{0}, DNS: &model.DNSStat{Names: []model.DNSName{{Name: "db.internal", Lookups: 1, Fails: 1}}}},
	}
	c := Aggregate(ys, time.Minute)[0]
	if len(c.DNS.Names) != 1 || c.DNS.Names[0].Fails != 3 || c.DNS.Names[0].LastError != "NONAME" {
		t.Fatalf("names: %+v", c.DNS.Names)
	}
}

func TestSecondBucketsAreTheSamples(t *testing.T) {
	xs := []model.Sample{{Probe: "runqlat", Time: sec(0)}, {Probe: "runqlat", Time: sec(1)}}
	if out := Aggregate(xs, time.Second); len(out) != 2 {
		t.Fatalf("a 1 s bucket must return the samples as they are")
	}
}
