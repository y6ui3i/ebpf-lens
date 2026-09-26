// ebpflens-agent は eBPF プローブの値とイベントを一定間隔で集め、ebpflens-server に送る
// (-server 未指定なら JSON Lines として標準出力に書く)。
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

	"github.com/yoshiharu-ishii/ebpf-lens/internal/model"
	"github.com/yoshiharu-ishii/ebpf-lens/internal/probe/proclife"
	"github.com/yoshiharu-ishii/ebpf-lens/internal/probe/runqlat"
)

func main() {
	interval := flag.Duration("interval", time.Second, "集計間隔")
	count := flag.Int("count", 0, "出力回数(0 なら無限)")
	text := flag.Bool("text", false, "JSON の代わりに runqlat 風のテキストヒストグラムを出す")
	serverURL := flag.String("server", "", "送信先の ebpflens-server(例: http://127.0.0.1:8080)")
	hostFlag := flag.String("host", "", "ホスト名(省略時は os.Hostname)")
	topN := flag.Int("top", 8, "送るプロセス数(待ち時間の上位と CPU 使用の上位それぞれ)")
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

	pl, err := proclife.Open()
	if err != nil {
		log.Fatalf("proclife: %v", err)
	}
	defer pl.Close()
	// ring buffer の読み出しは別 goroutine で回し、区間ごとにまとめて送る
	events := make(chan model.ProcEvent, eventBuffer)
	var agentDrops atomic.Uint64
	go func() {
		if err := pl.Run(events, func() { agentDrops.Add(1) }); err != nil {
			log.Fatalf("proclife: %v", err)
		}
	}()

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
			all, err := p.Procs()
			if err != nil {
				log.Fatalf("runqlat: %v", err)
			}
			var busy uint64
			for _, s := range all {
				busy += s.OnCPUNs
			}
			procs := topProcs(all, *topN)

			batch := model.EventBatch{Host: host, Time: now, Events: drain(events, maxEventsPerBatch)}
			kdrop, err := pl.DroppedDelta()
			if err != nil {
				log.Printf("proclife dropped: %v", err)
			}
			batch.Dropped = kdrop + agentDrops.Swap(0)

			if *text {
				printText(now, slots)
				printProcs(procs)
				printEvents(batch)
				continue
			}
			x := model.Sample{
				Host: host, Time: now, Probe: "runqlat", Unit: "usecs", Slots: slots[:],
				IntervalMs: now.Sub(prev).Milliseconds(), CPUs: runtime.NumCPU(), BusyNs: busy, Procs: procs,
			}
			prev = now
			if *serverURL != "" {
				// サーバーが落ちていても収集は続ける。その区間のデータは捨てる
				if err := send(client, *serverURL, "/api/ingest", x); err != nil {
					log.Printf("send sample: %v", err)
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
			if len(batch.Events) > 0 {
				if err := enc.Encode(batch); err != nil {
					log.Fatal(err)
				}
			}
		}
	}
}

const (
	eventBuffer       = 16384
	maxEventsPerBatch = 2000 // これを超えた分は次の区間に回る
)

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
		}
	}
	if b.Dropped > 0 {
		fmt.Printf("dropped %d events\n", b.Dropped)
	}
}

// topProcs は待たされた時間の上位 n 件と CPU を使った時間の上位 n 件を合わせて返す。
func topProcs(all []model.ProcStat, n int) []model.ProcStat {
	pick := map[string]bool{}
	for _, cmp := range []func(a, b model.ProcStat) int{
		func(a, b model.ProcStat) int { return cmpDesc(a.WaitNs, b.WaitNs) },
		func(a, b model.ProcStat) int { return cmpDesc(a.OnCPUNs, b.OnCPUNs) },
	} {
		slices.SortFunc(all, cmp)
		for _, s := range all[:min(n, len(all))] {
			pick[s.Comm] = true
		}
	}
	out := make([]model.ProcStat, 0, len(pick))
	for _, s := range all {
		if pick[s.Comm] {
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
