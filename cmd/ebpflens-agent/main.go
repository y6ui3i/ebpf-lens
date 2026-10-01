// ebpflens-agent collects eBPF probe values, events and the list of running VMs at a fixed interval and sends them to ebpflens-server
// (if -server is not given, it writes them to stdout as JSON Lines).
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"slices"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/y6ui3i/ebpf-lens/internal/fileerr"
	"github.com/y6ui3i/ebpf-lens/internal/model"
	"github.com/y6ui3i/ebpf-lens/internal/netdrop"
	"github.com/y6ui3i/ebpf-lens/internal/probe/biolat"
	"github.com/y6ui3i/ebpf-lens/internal/probe/dnslat"
	"github.com/y6ui3i/ebpf-lens/internal/probe/fileops"
	"github.com/y6ui3i/ebpf-lens/internal/probe/gpu"
	"github.com/y6ui3i/ebpf-lens/internal/probe/irqlat"
	"github.com/y6ui3i/ebpf-lens/internal/probe/lockwait"
	"github.com/y6ui3i/ebpf-lens/internal/probe/memstall"
	"github.com/y6ui3i/ebpf-lens/internal/probe/pgfault"
	"github.com/y6ui3i/ebpf-lens/internal/probe/proclife"
	"github.com/y6ui3i/ebpf-lens/internal/probe/runqlat"
	"github.com/y6ui3i/ebpf-lens/internal/probe/tcpconn"
	"github.com/y6ui3i/ebpf-lens/internal/procfs"
	"github.com/y6ui3i/ebpf-lens/internal/vm"
)

func main() {
	interval := flag.Duration("interval", time.Second, "aggregation interval")
	count := flag.Int("count", 0, "number of outputs (0 means unlimited)")
	text := flag.Bool("text", false, "print a runqlat-style text histogram instead of JSON")
	serverURL := flag.String("server", "", "ebpflens-server to send to (e.g. http://127.0.0.1:8080)")
	hostFlag := flag.String("host", "", "host name (defaults to os.Hostname)")
	topN := flag.Int("top", 8, "number of processes to send (each for the top by wait time and the top by CPU usage)")
	flag.Parse()

	host := *hostFlag
	if host == "" {
		h, err := os.Hostname()
		if err != nil {
			log.Fatalf("hostname: %v", err)
		}
		host = h
	}
	client := &http.Client{Timeout: 2 * time.Second}

	p, err := runqlat.Open()
	if err != nil {
		log.Fatalf("runqlat: %v", err)
	}
	defer p.Close()

	ms, err := memstall.Open()
	if err != nil {
		log.Fatalf("memstall: %v", err)
	}
	defer ms.Close()
	mem := newMemReader()

	// VMs: file QEMU processes under their VM name, and tag their events so the server can explain "VM X stopped"
	vms := vm.NewMap()
	vms.Scan()
	lastScan := time.Now()

	pl, err := proclife.Open()
	if err != nil {
		log.Fatalf("proclife: %v", err)
	}
	defer pl.Close()
	// Read the ring buffer in a separate goroutine and send the events in one batch per interval
	events := make(chan model.ProcEvent, eventBuffer)
	var agentDrops atomic.Uint64
	go func() {
		if err := pl.Run(events, func() { agentDrops.Add(1) }); err != nil {
			log.Fatalf("proclife: %v", err)
		}
	}()

	bl, err := biolat.Open()
	if err != nil {
		log.Fatalf("biolat: %v", err)
	}
	defer bl.Close()

	tc, err := tcpconn.Open()
	if err != nil {
		log.Fatalf("tcpconn: %v", err)
	}
	defer tc.Close()
	if tc.Warning != "" {
		log.Printf("tcpconn: %s", tc.Warning)
	}

	fo, err := fileops.Open()
	if err != nil {
		log.Fatalf("fileops: %v", err)
	}
	defer fo.Close()

	lw, err := lockwait.Open()
	if err != nil {
		log.Fatalf("lockwait: %v", err)
	}
	defer lw.Close()
	if lw.Warning != "" {
		log.Printf("lockwait: %s", lw.Warning)
	}

	pf, err := pgfault.Open()
	if err != nil {
		log.Fatalf("pgfault: %v", err)
	}
	defer pf.Close()
	swap := &swapReader{}

	iq, err := irqlat.Open()
	if err != nil {
		log.Fatalf("irqlat: %v", err)
	}
	defer iq.Close()

	// DNS: optional. Without glibc at the usual paths (or on a kernel without multi-uprobe links) there are no dns samples
	dns := openDNS()
	if dns != nil {
		defer dns.Close()
	}

	// GPU: optional. A host without an NVIDIA driver, or without libcuda, simply sends no "gpu" samples
	gw := openGPU()
	defer gw.Close()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	tick := time.NewTicker(*interval)
	defer tick.Stop()

	enc := json.NewEncoder(os.Stdout)
	prev := time.Now()
	for n := 0; *count == 0 || n < *count; n++ {
		select {
		case <-sig:
			return
		case now := <-tick.C:
			slots, err := p.Delta()
			if err != nil {
				log.Fatalf("runqlat: %v", err)
			}
			if now.Sub(lastScan) >= vmScanInterval {
				vms.Scan()
				lastScan = now
			}
			all, err := p.Procs(vms.Label)
			if err != nil {
				log.Fatalf("runqlat: %v", err)
			}
			var busy uint64
			for _, s := range all {
				busy += s.OnCPUNs
			}
			procs := topProcs(all, *topN)

			// Aggregate memstall (and list the VMs) before draining events: an exit event removes its VM from the
			// map, and the second in which a VM dies is exactly the one whose reclaim stalls must still be filed under it
			mx, err := memSample(ms, mem, vms, *topN)
			if err != nil {
				log.Fatalf("memstall: %v", err)
			}
			mx.Host, mx.Time, mx.IntervalMs, mx.CPUs = host, now, now.Sub(prev).Milliseconds(), runtime.NumCPU()
			vx := model.Sample{Host: host, Time: now, Probe: "vms", Slots: []uint64{0}, IntervalMs: now.Sub(prev).Milliseconds(), VMs: vms.List()}
			dx, err := diskSample(bl, vms, *topN)
			if err != nil {
				log.Fatalf("biolat: %v", err)
			}
			dx.Host, dx.Time, dx.IntervalMs = host, now, now.Sub(prev).Milliseconds()
			nx, err := netSample(tc, vms, *topN)
			if err != nil {
				log.Fatalf("tcpconn: %v", err)
			}
			nx.Host, nx.Time, nx.IntervalMs = host, now, now.Sub(prev).Milliseconds()
			fx, err := fileSample(fo, vms, *topN)
			if err != nil {
				log.Fatalf("fileops: %v", err)
			}
			fx.Host, fx.Time, fx.IntervalMs = host, now, now.Sub(prev).Milliseconds()
			lx, err := lockSample(lw, vms, *topN)
			if err != nil {
				log.Fatalf("lockwait: %v", err)
			}
			lx.Host, lx.Time, lx.IntervalMs = host, now, now.Sub(prev).Milliseconds()
			px, err := faultSample(pf, swap, vms, *topN)
			if err != nil {
				log.Fatalf("pgfault: %v", err)
			}
			px.Host, px.Time, px.IntervalMs = host, now, now.Sub(prev).Milliseconds()
			ix, err := irqSample(iq)
			if err != nil {
				log.Fatalf("irqlat: %v", err)
			}
			ix.Host, ix.Time, ix.IntervalMs, ix.CPUs = host, now, now.Sub(prev).Milliseconds(), runtime.NumCPU()
			var sx *model.Sample
			if dns != nil {
				x, err := dnsSample(dns, vms, *topN)
				if err != nil {
					log.Fatalf("dnslat: %v", err)
				}
				x.Host, x.Time, x.IntervalMs = host, now, now.Sub(prev).Milliseconds()
				sx = &x
			}
			gx, err := gw.sample(all, vms.Label)
			if err != nil {
				log.Fatalf("gpu: %v", err)
			}
			if gx != nil {
				gx.Host, gx.Time, gx.IntervalMs = host, now, now.Sub(prev).Milliseconds()
			}

			batch := model.EventBatch{Host: host, Time: now, Events: tagVMs(vms, drain(events, maxEventsPerBatch))}
			kdrop, err := pl.DroppedDelta()
			if err != nil {
				log.Printf("proclife dropped: %v", err)
			}
			batch.Dropped = kdrop + agentDrops.Swap(0)

			if *text {
				printText(now, slots)
				printProcs(procs)
				printMem(mx)
				printDisk(dx)
				printNet(nx)
				printFiles(fx)
				printLocks(lx)
				printFaults(px)
				printIRQ(ix)
				if sx != nil {
					printDNS(*sx)
				}
				if gx != nil {
					printGPU(*gx)
				}
				printEvents(batch)
				continue
			}
			x := model.Sample{
				Host: host, Time: now, Probe: "runqlat", Unit: "usecs", Slots: slots[:],
				IntervalMs: now.Sub(prev).Milliseconds(), CPUs: runtime.NumCPU(), BusyNs: busy, Procs: procs,
			}
			prev = now
			if *serverURL != "" {
				// Keep collecting even if the server is down. That interval's data is discarded
				if err := send(client, *serverURL, "/api/ingest", x); err != nil {
					log.Printf("send sample: %v", err)
				}
				if err := send(client, *serverURL, "/api/ingest", mx); err != nil {
					log.Printf("send memstall: %v", err)
				}
				if err := send(client, *serverURL, "/api/ingest", vx); err != nil {
					log.Printf("send vms: %v", err)
				}
				if err := send(client, *serverURL, "/api/ingest", dx); err != nil {
					log.Printf("send biolat: %v", err)
				}
				if err := send(client, *serverURL, "/api/ingest", nx); err != nil {
					log.Printf("send tcpconn: %v", err)
				}
				if err := send(client, *serverURL, "/api/ingest", fx); err != nil {
					log.Printf("send fileops: %v", err)
				}
				if err := send(client, *serverURL, "/api/ingest", lx); err != nil {
					log.Printf("send lockwait: %v", err)
				}
				if err := send(client, *serverURL, "/api/ingest", px); err != nil {
					log.Printf("send pgfault: %v", err)
				}
				if err := send(client, *serverURL, "/api/ingest", ix); err != nil {
					log.Printf("send irqlat: %v", err)
				}
				if sx != nil {
					if err := send(client, *serverURL, "/api/ingest", *sx); err != nil {
						log.Printf("send dnslat: %v", err)
					}
				}
				if gx != nil {
					if err := send(client, *serverURL, "/api/ingest", *gx); err != nil {
						log.Printf("send gpu: %v", err)
					}
				}
				if len(batch.Events) > 0 || batch.Dropped > 0 {
					if err := send(client, *serverURL, "/api/events", batch); err != nil {
						log.Printf("send events: %v", err)
					}
				}
				continue
			}
			if err := enc.Encode(x); err != nil {
				log.Fatal(err)
			}
			if err := enc.Encode(mx); err != nil {
				log.Fatal(err)
			}
			if len(vx.VMs) > 0 {
				if err := enc.Encode(vx); err != nil {
					log.Fatal(err)
				}
			}
			if err := enc.Encode(dx); err != nil {
				log.Fatal(err)
			}
			if err := enc.Encode(nx); err != nil {
				log.Fatal(err)
			}
			if err := enc.Encode(fx); err != nil {
				log.Fatal(err)
			}
			if err := enc.Encode(lx); err != nil {
				log.Fatal(err)
			}
			if err := enc.Encode(px); err != nil {
				log.Fatal(err)
			}
			if err := enc.Encode(ix); err != nil {
				log.Fatal(err)
			}
			if sx != nil {
				if err := enc.Encode(*sx); err != nil {
					log.Fatal(err)
				}
			}
			if gx != nil {
				if err := enc.Encode(*gx); err != nil {
					log.Fatal(err)
				}
			}
			if len(batch.Events) > 0 {
				if err := enc.Encode(batch); err != nil {
					log.Fatal(err)
				}
			}
		}
	}
}

// memReader reads values from /proc and turns the cumulative PSI totals into per-interval deltas.
type memReader struct{ prev *procfs.PSI }

func newMemReader() *memReader { return &memReader{} }

func (r *memReader) read(stallNs uint64) *model.MemStat {
	m := &model.MemStat{StallNs: stallNs}
	if mi, err := procfs.ReadMemInfo(); err == nil {
		m.TotalBytes, m.AvailableBytes = mi.TotalBytes, mi.AvailableBytes
	}
	if psi, err := procfs.ReadPSI("memory"); err == nil {
		if r.prev != nil {
			m.PsiSomeUs = psi.SomeTotalUs - r.prev.SomeTotalUs
			m.PsiFullUs = psi.FullTotalUs - r.prev.FullTotalUs
		}
		r.prev = &psi
	}
	return m
}

// memSample builds one interval of memstall data (the caller fills in host name, time, etc.).
func memSample(ms *memstall.Probe, mem *memReader, vms *vm.Map, topN int) (model.Sample, error) {
	slots, err := ms.Delta()
	if err != nil {
		return model.Sample{}, err
	}
	all, err := ms.Procs(vms.Label)
	if err != nil {
		return model.Sample{}, err
	}
	var stall uint64
	for _, s := range all {
		stall += s.WaitNs
	}
	return model.Sample{
		Probe: "memstall", Unit: "usecs", Slots: slots[:],
		Procs: topProcs(all, topN), Mem: mem.read(stall),
	}, nil
}

// diskSample builds one interval of block I/O data: the latency histogram, the devices, and the processes that
// issued the most I/O (top by latency total and by bytes; the caller fills in host name, time, etc.).
func diskSample(bl *biolat.Probe, vms *vm.Map, topN int) (model.Sample, error) {
	slots, err := bl.Delta()
	if err != nil {
		return model.Sample{}, err
	}
	all, err := bl.Procs(vms.Label)
	if err != nil {
		return model.Sample{}, err
	}
	devs, err := bl.Devices()
	if err != nil {
		return model.Sample{}, err
	}
	if devs == nil {
		devs = []model.DiskDev{} // an idle second is an empty list, not null, so the UI can reduce over it
	}
	slices.SortFunc(devs, func(a, b model.DiskDev) int { return cmpDesc(a.Reads+a.Writes, b.Reads+b.Writes) })
	procs := topBy(all, topN,
		func(a, b model.ProcStat) int { return cmpDesc(a.WaitNs, b.WaitNs) },
		func(a, b model.ProcStat) int { return cmpDesc(a.ReadBytes+a.WriteBytes, b.ReadBytes+b.WriteBytes) },
	)
	return model.Sample{
		Probe: "biolat", Unit: "usecs", Slots: slots[:], Procs: procs, Disk: &model.DiskStat{Devices: devs},
	}, nil
}

func printDisk(x model.Sample) {
	for _, d := range x.Disk.Devices {
		fmt.Printf("disk %-10s r=%d w=%d rMB=%.1f wMB=%.1f err=%d lat_avg=%.2fms max=%.2fms\n",
			d.Name, d.Reads, d.Writes, float64(d.ReadBytes)/1e6, float64(d.WriteBytes)/1e6, d.Errors,
			float64(d.LatNs)/1e6/float64(max(1, d.Reads+d.Writes)), float64(d.LatMaxNs)/1e6)
	}
	for _, s := range x.Procs {
		fmt.Printf("  %-16s x%-3d ios=%d rMB=%.1f wMB=%.1f lat=%.2fms max=%.2fms\n",
			s.Comm, s.Procs, s.WaitCount, float64(s.ReadBytes)/1e6, float64(s.WriteBytes)/1e6, float64(s.WaitNs)/1e6, float64(s.WaitMaxNs)/1e6)
	}
}

// netSample builds one interval of outbound TCP data: the connect latency histogram, the destinations, and the
// processes that connected the most (top by connects and by failures).
func netSample(tc *tcpconn.Probe, vms *vm.Map, topN int) (model.Sample, error) {
	slots, err := tc.Delta()
	if err != nil {
		return model.Sample{}, err
	}
	all, err := tc.Procs(vms.Label)
	if err != nil {
		return model.Sample{}, err
	}
	dests, err := tc.Dests()
	if err != nil {
		return model.Sample{}, err
	}
	if dests == nil {
		dests = []model.NetDest{}
	}
	slices.SortFunc(dests, func(a, b model.NetDest) int {
		return cmpDesc(a.Connects+a.Fails*4+a.Retrans, b.Connects+b.Fails*4+b.Retrans) // trouble first
	})
	if len(dests) > maxDests {
		dests = dests[:maxDests]
	}
	drops, flows, err := tc.Drops()
	if err != nil {
		return model.Sample{}, err
	}
	slices.SortFunc(drops, func(a, b model.NetDrop) int { return cmpDesc(a.Count, b.Count) })
	// Trouble first, then by count: the rows that must survive the cap are the ones an incident would name
	slices.SortFunc(flows, func(a, b model.NetDropFlow) int {
		if ta, tb := netdrop.Tier(a.Reason) == netdrop.TierTrouble, netdrop.Tier(b.Reason) == netdrop.TierTrouble; ta != tb {
			if ta {
				return -1
			}
			return 1
		}
		return cmpDesc(a.Count, b.Count)
	})
	if len(flows) > maxDests {
		flows = flows[:maxDests]
	}
	procs := topBy(all, topN,
		func(a, b model.ProcStat) int { return cmpDesc(a.WaitCount, b.WaitCount) },
		func(a, b model.ProcStat) int { return cmpDesc(a.ConnectFails, b.ConnectFails) },
	)
	return model.Sample{
		Probe: "tcpconn", Unit: "usecs", Slots: slots[:], Procs: procs, Net: &model.NetStat{Dests: dests, Drops: drops, DropFlows: flows},
	}, nil
}

// fileSample builds one interval of file data: the fsync latency histogram, the failed opens (trouble first, then
// by count), the fsynced files, and the processes that fsynced or failed the most.
func fileSample(fo *fileops.Probe, vms *vm.Map, topN int) (model.Sample, error) {
	slots, err := fo.Delta()
	if err != nil {
		return model.Sample{}, err
	}
	all, err := fo.Procs(vms.Label)
	if err != nil {
		return model.Sample{}, err
	}
	errs, fails, err := fo.Opens(vms.Label)
	if err != nil {
		return model.Sample{}, err
	}
	files, err := fo.Files()
	if err != nil {
		return model.Sample{}, err
	}
	tierRank := map[string]int{fileerr.TierTrouble: 0, fileerr.TierNotable: 1, fileerr.TierNoise: 2}
	slices.SortFunc(fails, func(a, b model.FileOpenFail) int {
		if d := tierRank[a.Tier] - tierRank[b.Tier]; d != 0 {
			return d
		}
		return cmpDesc(a.Count, b.Count)
	})
	if len(fails) > maxDests {
		fails = fails[:maxDests]
	}
	slices.SortFunc(errs, func(a, b model.FileOpenErr) int { return cmpDesc(a.Count, b.Count) })
	slices.SortFunc(files, func(a, b model.FileSync) int { return cmpDesc(a.LatNs, b.LatNs) })
	if len(files) > maxDests {
		files = files[:maxDests]
	}
	procs := topBy(all, topN,
		func(a, b model.ProcStat) int { return cmpDesc(a.WaitNs, b.WaitNs) },
		func(a, b model.ProcStat) int { return cmpDesc(a.OpenFails, b.OpenFails) },
	)
	return model.Sample{Probe: "fileops", Unit: "usecs", Slots: slots[:], Procs: procs,
		Files: &model.FileStat{OpenErrs: errs, OpenFails: fails, Fsyncs: files}}, nil
}

func printFiles(x model.Sample) {
	for _, e := range x.Files.OpenErrs {
		fmt.Printf("open %-8s n=%d\n", e.Error, e.Count)
	}
	for _, f := range x.Files.OpenFails {
		if f.Tier != fileerr.TierNoise {
			fmt.Printf("  %-16s %-8s %-8s %s n=%d\n", f.Comm, f.Error, f.Tier, f.Path, f.Count)
		}
	}
	for _, f := range x.Files.Fsyncs {
		fmt.Printf("fsync %-40s n=%d avg=%.2fms max=%.2fms\n", f.Name, f.Fsyncs, float64(f.LatNs)/1e6/float64(max(1, f.Fsyncs)), float64(f.LatMaxNs)/1e6)
	}
}

// lockSample builds one interval of lock waiting: the histogram of contended user-lock waits, the processes
// that waited the most (user locks and kernel locks), and the kernel lock kinds.
func lockSample(lw *lockwait.Probe, vms *vm.Map, topN int) (model.Sample, error) {
	r, err := lw.Read(vms.Label)
	if err != nil {
		return model.Sample{}, err
	}
	r.Stat.ParkedNs = r.Parked
	procs := topBy(r.Procs, topN,
		func(a, b model.ProcStat) int { return cmpDesc(a.WaitNs, b.WaitNs) },
		func(a, b model.ProcStat) int { return cmpDesc(a.KernelLockNs, b.KernelLockNs) },
	)
	return model.Sample{Probe: "lockwait", Unit: "usecs", Slots: r.Slots[:], Procs: procs, Lock: &r.Stat}, nil
}

func printLocks(x model.Sample) {
	l := x.Lock
	if l.UserWaits == 0 && len(l.Kernel) == 0 {
		return
	}
	fmt.Printf("lock user: waits=%d total=%.1fms parked=%.1fms\n", l.UserWaits, float64(l.UserNs)/1e6, float64(l.ParkedNs)/1e6)
	for _, k := range l.Kernel {
		fmt.Printf("lock kernel %-13s waits=%d total=%.2fms\n", k.Kind, k.Count, float64(k.LatNs)/1e6)
	}
	for _, s := range x.Procs {
		fmt.Printf("  %-16s x%-3d locks=%d waits=%d user=%.1fms max=%.1fms kernel=%d/%.2fms\n",
			s.Comm, s.Procs, s.Locks, s.WaitCount, float64(s.WaitNs)/1e6, float64(s.WaitMaxNs)/1e6, s.KernelLockCount, float64(s.KernelLockNs)/1e6)
	}
}

// swapReader turns the cumulative /proc/vmstat swap counters into per-interval deltas and reads the swap size.
type swapReader struct{ prev *procfs.VMStat }

func (r *swapReader) fill(f *model.FaultStat) {
	if mi, err := procfs.ReadMemInfo(); err == nil {
		f.SwapTotalBytes, f.SwapUsedBytes = mi.SwapTotalBytes, mi.SwapTotalBytes-mi.SwapFreeBytes
	}
	if v, err := procfs.ReadVMStat(); err == nil {
		if r.prev != nil {
			f.SwapInPages, f.SwapOutPages = v.SwapIn-r.prev.SwapIn, v.SwapOut-r.prev.SwapOut
		}
		r.prev = &v
	}
}

// faultSample builds one interval of page faults: the major-fault latency histogram, the totals with the swap
// state, and the processes that faulted the most (top by time stalled in major faults and by minor faults).
func faultSample(pf *pgfault.Probe, swap *swapReader, vms *vm.Map, topN int) (model.Sample, error) {
	slots, err := pf.Delta()
	if err != nil {
		return model.Sample{}, err
	}
	all, tot, err := pf.Procs(vms.Label)
	if err != nil {
		return model.Sample{}, err
	}
	swap.fill(&tot)
	procs := topBy(all, topN,
		func(a, b model.ProcStat) int { return cmpDesc(a.WaitNs, b.WaitNs) },
		func(a, b model.ProcStat) int { return cmpDesc(a.MinorFaults, b.MinorFaults) },
	)
	return model.Sample{Probe: "pgfault", Unit: "usecs", Slots: slots[:], Procs: procs, Faults: &tot}, nil
}

func printFaults(x model.Sample) {
	f := x.Faults
	fmt.Printf("fault minor=%d major=%d swapin=%d stall=%.1fms swap=%.0f/%.0fMiB in=%d out=%d\n",
		f.Minor, f.Major, f.SwapIn, float64(f.MajorNs)/1e6, float64(f.SwapUsedBytes)/(1<<20), float64(f.SwapTotalBytes)/(1<<20), f.SwapInPages, f.SwapOutPages)
	for _, s := range x.Procs {
		if s.WaitCount > 0 {
			fmt.Printf("  %-16s x%-3d minor=%d major=%d swapin=%d stall=%.1fms max=%.1fms\n", s.Comm, s.Procs, s.MinorFaults, s.WaitCount, s.SwapIns, float64(s.WaitNs)/1e6, float64(s.WaitMaxNs)/1e6)
		}
	}
}

// irqSample builds one interval of interrupt time: the softirq run-time histogram and the per-CPU, per-vector and
// per-IRQ totals (the busiest first; the lists are capped like the others).
func irqSample(iq *irqlat.Probe) (model.Sample, error) {
	slots, err := iq.Delta()
	if err != nil {
		return model.Sample{}, err
	}
	st, err := iq.Read()
	if err != nil {
		return model.Sample{}, err
	}
	if st.CPUs == nil {
		st.CPUs = []model.CPUIRQ{}
	}
	slices.SortFunc(st.CPUs, func(a, b model.CPUIRQ) int { return a.CPU - b.CPU })
	slices.SortFunc(st.Softirqs, func(a, b model.SoftirqStat) int { return cmpDesc(a.Ns, b.Ns) })
	slices.SortFunc(st.IRQs, func(a, b model.HardIRQ) int { return cmpDesc(a.Ns, b.Ns) })
	if len(st.Softirqs) > maxIRQRows {
		st.Softirqs = st.Softirqs[:maxIRQRows]
	}
	if len(st.IRQs) > maxDests {
		st.IRQs = st.IRQs[:maxDests]
	}
	return model.Sample{Probe: "irqlat", Unit: "usecs", Slots: slots[:], IRQ: &st}, nil
}

// (cpu, vector) rows: enough for 16 CPUs × the 10 vectors; bigger hosts keep the busiest
const maxIRQRows = 160

func printIRQ(x model.Sample) {
	for _, c := range x.IRQ.CPUs {
		if c.SoftirqNs+c.IRQNs > 1e6 {
			fmt.Printf("irq cpu%-3d softirq=%.2fms irq=%.2fms (%d)\n", c.CPU, float64(c.SoftirqNs)/1e6, float64(c.IRQNs)/1e6, c.IRQCount)
		}
	}
	for _, s := range x.IRQ.Softirqs[:min(5, len(x.IRQ.Softirqs))] {
		fmt.Printf("  softirq %-8s cpu%-3d n=%d %.2fms\n", s.Vec, s.CPU, s.Count, float64(s.Ns)/1e6)
	}
	for _, s := range x.IRQ.IRQs[:min(5, len(x.IRQ.IRQs))] {
		fmt.Printf("  irq %-16s n=%d %.2fms\n", s.Name, s.Count, float64(s.Ns)/1e6)
	}
}

func openDNS() *dnslat.Probe {
	path, err := dnslat.FindLibc()
	if err != nil {
		log.Printf("dnslat: %v (no DNS samples)", err)
		return nil
	}
	p, err := dnslat.Open(path)
	if err != nil {
		log.Printf("dnslat: %v (no DNS samples)", err)
		return nil
	}
	log.Printf("dnslat: uprobes on getaddrinfo in %s", path)
	return p
}

// dnsSample builds one interval of name resolution: the latency histogram, the names (failures first), and the
// processes that resolved the most (top by lookups and by failures).
func dnsSample(p *dnslat.Probe, vms *vm.Map, topN int) (model.Sample, error) {
	slots, err := p.Delta()
	if err != nil {
		return model.Sample{}, err
	}
	all, err := p.Procs(vms.Label)
	if err != nil {
		return model.Sample{}, err
	}
	names, err := p.Names()
	if err != nil {
		return model.Sample{}, err
	}
	if names == nil {
		names = []model.DNSName{}
	}
	slices.SortFunc(names, func(a, b model.DNSName) int { return cmpDesc(a.Lookups+a.Fails*4, b.Lookups+b.Fails*4) })
	if len(names) > maxDests {
		names = names[:maxDests]
	}
	procs := topBy(all, topN,
		func(a, b model.ProcStat) int { return cmpDesc(a.WaitCount, b.WaitCount) },
		func(a, b model.ProcStat) int { return cmpDesc(a.LookupFails, b.LookupFails) },
	)
	return model.Sample{Probe: "dnslat", Unit: "usecs", Slots: slots[:], Procs: procs, DNS: &model.DNSStat{Names: names}}, nil
}

func printDNS(x model.Sample) {
	for _, n := range x.DNS.Names {
		fmt.Printf("dns  %-40s n=%d fail=%d err=%s avg=%.2fms max=%.2fms\n", n.Name, n.Lookups, n.Fails, n.LastError,
			float64(n.LatNs)/1e6/float64(max(1, n.Lookups)), float64(n.LatMaxNs)/1e6)
	}
}

// A busy host talks to many destinations; the sample must stay under the server's 64 KiB body limit
const maxDests = 50

func printNet(x model.Sample) {
	for _, d := range x.Net.Dests {
		fmt.Printf("net  %-21s ok=%d fail=%d retrans=%d lat_avg=%.2fms max=%.2fms\n",
			fmt.Sprintf("%s:%d", d.Addr, d.Port), d.Connects, d.Fails, d.Retrans,
			float64(d.LatNs)/1e6/float64(max(1, d.Connects)), float64(d.LatMaxNs)/1e6)
	}
	for _, s := range x.Procs {
		fmt.Printf("  %-16s x%-3d connects=%d fails=%d lat=%.2fms max=%.2fms\n",
			s.Comm, s.Procs, s.WaitCount, s.ConnectFails, float64(s.WaitNs)/1e6, float64(s.WaitMaxNs)/1e6)
	}
	for _, d := range x.Net.Drops {
		fmt.Printf("drop %-28s %-8s n=%d\n", d.Reason, d.Tier, d.Count)
	}
	for _, f := range x.Net.DropFlows {
		who := ""
		if f.Listener != "" {
			who = " listener=" + f.Listener
		}
		fmt.Printf("  %-28s %s %s -> %s:%d n=%d%s\n", f.Reason, f.Proto, f.Src, f.Dst, f.Dport, f.Count, who)
	}
}

// gpuWatch is the GPU half of the agent: NVML for the GPU's own counters and uprobes on libcuda for what each
// process does with it. Either half may be missing (no driver: neither; a driver without libcuda: NVML only).
type gpuWatch struct {
	nv   *gpu.NVML
	prb  *gpu.Probe
	comm map[uint32]string // pid -> name, for processes NVML reports that made no CUDA call this interval
}

func openGPU() *gpuWatch {
	w := &gpuWatch{comm: map[uint32]string{}}
	nv, err := gpu.OpenNVML()
	if err != nil {
		log.Printf("gpu: %v (no GPU samples)", err)
		return w
	}
	w.nv = nv
	path, err := gpu.FindLibcuda()
	if err != nil {
		log.Printf("gpu: %v (GPU samples without per-process detail)", err)
		return w
	}
	prb, err := gpu.Open(path)
	if err != nil {
		log.Printf("gpu: %v (GPU samples without per-process detail)", err)
		return w
	}
	w.prb = prb
	log.Printf("gpu: %s, uprobes on %s", nv.Name(), path)
	return w
}

func (w *gpuWatch) Close() {
	if w.prb != nil {
		w.prb.Close()
	}
	if w.nv != nil {
		w.nv.Close()
	}
}

// sample builds one interval of GPU data, or nil when there is no GPU. cpuProcs (from runqlat, same interval)
// supplies each CUDA process's CPU time, so the verdict can tell "busy on the CPU" from "waiting for something else".
func (w *gpuWatch) sample(cpuProcs []model.ProcStat, label func(uint32, string) string) (*model.Sample, error) {
	if w.nv == nil {
		return nil, nil
	}
	g, vram := w.nv.Read()
	slots := []uint64{0}
	var procs []model.GPUProc
	if w.prb != nil {
		d, err := w.prb.Delta()
		if err != nil {
			return nil, err
		}
		slots = d[:]
		if procs, err = w.prb.Procs(label); err != nil {
			return nil, err
		}
		g.Uprobes = true
	}
	// Merge: VRAM by pid from NVML onto the uprobe rows. A process holding VRAM without any CUDA call this
	// interval (a loaded model sitting idle) still gets a row, so the UI can say it is idle rather than miss it
	rowOfPid := map[uint32]int{}
	rowOfComm := map[string]int{}
	for i, p := range procs {
		rowOfComm[p.Comm] = i
		for _, pid := range p.Pids {
			rowOfPid[pid] = i
		}
	}
	for pid, bytes := range vram {
		i, ok := rowOfPid[pid]
		if !ok {
			name := w.commOf(pid)
			if label != nil {
				name = label(pid, name)
			}
			if i, ok = rowOfComm[name]; !ok {
				procs = append(procs, model.GPUProc{Comm: name})
				i = len(procs) - 1
				rowOfComm[name] = i
			}
			procs[i].Procs++
			if len(procs[i].Pids) < 5 {
				procs[i].Pids = append(procs[i].Pids, pid)
			}
		}
		procs[i].VRAMBytes += bytes
	}
	// CPU time in the same interval, from runqlat's per-process rows (merged by name there too)
	cpu := map[string]uint64{}
	for _, p := range cpuProcs {
		cpu[p.Comm] += p.OnCPUNs
	}
	for i := range procs {
		procs[i].OnCPUNs = cpu[procs[i].Comm]
	}
	slices.SortFunc(procs, func(a, b model.GPUProc) int {
		return cmpDesc(a.Launches+a.CopyCount+a.SyncCount, b.Launches+b.CopyCount+b.SyncCount)
	})
	g.Procs = procs
	return &model.Sample{Probe: "gpu", Unit: "usecs", Slots: slots, GPU: &g}, nil
}

// commOf reads a process name from /proc (cached; a pid is not reused within one interval in practice).
func (w *gpuWatch) commOf(pid uint32) string {
	if c, ok := w.comm[pid]; ok {
		return c
	}
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
	name := "?"
	if err == nil {
		name = strings.TrimSpace(string(b))
	}
	if len(w.comm) > 4096 {
		w.comm = map[uint32]string{}
	}
	w.comm[pid] = name
	return name
}

func printGPU(x model.Sample) {
	g := x.GPU
	fmt.Printf("gpu: %s util=%.0f%% mem=%.0f%% vram=%.0f/%.0fMiB temp=%dC power=%.0fW throttle=%v\n",
		g.Name, g.Util*100, g.MemUtil*100, float64(g.UsedBytes)/(1<<20), float64(g.TotalBytes)/(1<<20), g.TempC, g.PowerW, g.Throttle)
	for _, p := range g.Procs {
		fmt.Printf("  %-16s x%-3d vram=%.0fMiB launches=%d h2d=%.1fMB d2h=%.1fMB copy=%.1fms sync=%.1fms cpu=%.1fms\n",
			p.Comm, p.Procs, float64(p.VRAMBytes)/(1<<20), p.Launches, float64(p.H2DBytes)/1e6, float64(p.D2HBytes)/1e6,
			float64(p.CopyNs)/1e6, float64(p.SyncNs)/1e6, float64(p.OnCPUNs)/1e6)
	}
}

func printMem(x model.Sample) {
	m := x.Mem
	fmt.Printf("memstall: stall=%.2fms psi_some=%dus avail=%.1fGiB/%.1fGiB\n",
		float64(m.StallNs)/1e6, m.PsiSomeUs, float64(m.AvailableBytes)/(1<<30), float64(m.TotalBytes)/(1<<30))
	for _, s := range x.Procs {
		if s.WaitCount > 0 {
			fmt.Printf("  %-16s x%-3d stalls=%d total=%.2fms max=%.2fms reclaimed=%d memcg=%d\n",
				s.Comm, s.Procs, s.WaitCount, float64(s.WaitNs)/1e6, float64(s.WaitMaxNs)/1e6, s.ReclaimedPages, s.MemcgCount)
		}
	}
}

const (
	eventBuffer       = 16384
	maxEventsPerBatch = 2000 // anything beyond this carries over to the next interval
	vmScanInterval    = 10 * time.Second
)

// tagVMs learns new QEMU processes from exec events and tags every event of a known VM with its name.
// A VM's exit is tagged before the pid is forgotten, so the server sees "VM web-02 stopped", not just "qemu exited".
func tagVMs(vms *vm.Map, events []model.ProcEvent) []model.ProcEvent {
	for i := range events {
		e := &events[i]
		if e.Kind == "exec" && vm.IsQEMU(e.Comm) {
			vms.AddPid(e.Pid)
		}
		e.VM = vms.Lookup(e.Pid)
		if e.Kind == "exit" && e.VM != "" {
			vms.Remove(e.Pid)
		}
	}
	return events
}

func drain(ch <-chan model.ProcEvent, max int) []model.ProcEvent {
	out := []model.ProcEvent{}
	for len(out) < max {
		select {
		case e := <-ch:
			out = append(out, e)
		default:
			return out
		}
	}
	return out
}

func printEvents(b model.EventBatch) {
	for _, e := range b.Events {
		switch e.Kind {
		case "exec":
			fmt.Printf("exec %-7d %-16s %s\n", e.Pid, e.Comm, e.Filename)
		case "exit":
			fmt.Printf("exit %-7d %-16s status=%d signal=%d core=%v life=%s\n", e.Pid, e.Comm, e.ExitStatus, e.Signal, e.CoreDump, time.Duration(e.LifetimeNs))
		case "oom":
			fmt.Printf("oom  %-7d %-16s trigger=%s(%d) memcg=%v pages=%d\n", e.Pid, e.Comm, e.TriggerComm, e.TriggerPid, e.Memcg, e.TotalPages)
		case "signal":
			fmt.Printf("sig  %-7d %-16s signal=%d from=%s(%d)\n", e.Pid, e.Comm, e.Signal, e.TriggerComm, e.TriggerPid)
		}
	}
	if b.Dropped > 0 {
		fmt.Printf("dropped %d events\n", b.Dropped)
	}
}

// topProcs returns the union of the top n by time spent waiting and the top n by time spent on CPU.
func topProcs(all []model.ProcStat, n int) []model.ProcStat {
	return topBy(all, n,
		func(a, b model.ProcStat) int { return cmpDesc(a.WaitNs, b.WaitNs) },
		func(a, b model.ProcStat) int { return cmpDesc(a.OnCPUNs, b.OnCPUNs) },
	)
}

// topBy returns the union of the top n processes under each ordering (VMs are always included).
func topBy(all []model.ProcStat, n int, orders ...func(a, b model.ProcStat) int) []model.ProcStat {
	pick := map[string]bool{}
	for _, cmp := range orders {
		slices.SortFunc(all, cmp)
		for _, s := range all[:min(n, len(all))] {
			pick[s.Comm] = true
		}
	}
	out := make([]model.ProcStat, 0, len(pick))
	for _, s := range all {
		if pick[s.Comm] || strings.HasPrefix(s.Comm, vm.Prefix) { // VMs are always sent, top or not
			out = append(out, s)
		}
	}
	return out
}

func cmpDesc(a, b uint64) int {
	switch {
	case a > b:
		return -1
	case a < b:
		return 1
	}
	return 0
}

func printProcs(procs []model.ProcStat) {
	fmt.Printf("%-16s %5s %12s %10s %12s\n", "comm", "procs", "oncpu(ms)", "waits", "wait(ms)")
	for _, s := range procs {
		fmt.Printf("%-16s %5d %12.1f %10d %12.2f\n", s.Comm, s.Procs, float64(s.OnCPUNs)/1e6, s.WaitCount, float64(s.WaitNs)/1e6)
	}
}

func send(client *http.Client, serverURL, path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	resp, err := client.Post(strings.TrimRight(serverURL, "/")+path, "application/json", bytes.NewReader(b))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("server returned %s", resp.Status)
	}
	return nil
}

func printText(now time.Time, slots [runqlat.MaxSlots]uint64) {
	last := -1
	var max uint64
	for i, v := range slots {
		if v > 0 {
			last = i
		}
		if v > max {
			max = v
		}
	}
	fmt.Printf("\n%s\n%20s : %-10s %s\n", now.Format(time.TimeOnly), "usecs", "count", "distribution")
	for i := 0; i <= last; i++ {
		lo, hi := uint64(0), uint64(1)
		if i > 0 {
			lo, hi = 1<<i, 1<<(i+1)-1
		}
		bar := 0
		if max > 0 {
			bar = int(slots[i] * 40 / max)
		}
		fmt.Printf("%9d -> %-8d : %-10d |%-40s|\n", lo, hi, slots[i], strings.Repeat("*", bar))
	}
}
