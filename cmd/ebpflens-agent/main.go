// ebpflens-agent は eBPF プローブの値を一定間隔で集め、ebpflens-server に送る
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
	"strings"
	"syscall"
	"time"

	"github.com/yoshiharu-ishii/ebpf-lens/internal/model"
	"github.com/yoshiharu-ishii/ebpf-lens/internal/probe/runqlat"
)

func main() {
	interval := flag.Duration("interval", time.Second, "集計間隔")
	count := flag.Int("count", 0, "出力回数(0 なら無限)")
	text := flag.Bool("text", false, "JSON の代わりに runqlat 風のテキストヒストグラムを出す")
	serverURL := flag.String("server", "", "送信先の ebpflens-server(例: http://127.0.0.1:8080)")
	hostFlag := flag.String("host", "", "ホスト名(省略時は os.Hostname)")
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

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	tick := time.NewTicker(*interval)
	defer tick.Stop()

	enc := json.NewEncoder(os.Stdout)
	for n := 0; *count == 0 || n < *count; n++ {
		select {
		case <-sig:
			return
		case now := <-tick.C:
			slots, err := p.Delta()
			if err != nil {
				log.Fatalf("runqlat: %v", err)
			}
			if *text {
				printText(now, slots)
				continue
			}
			x := model.Sample{Host: host, Time: now, Probe: "runqlat", Unit: "usecs", Slots: slots[:]}
			if *serverURL != "" {
				// サーバーが落ちていても収集は続ける。その区間のサンプルは捨てる
				if err := send(client, *serverURL, x); err != nil {
					log.Printf("send: %v", err)
				}
				continue
			}
			if err := enc.Encode(x); err != nil {
				log.Fatal(err)
			}
		}
	}
}

func send(client *http.Client, serverURL string, x model.Sample) error {
	b, err := json.Marshal(x)
	if err != nil {
		return err
	}
	resp, err := client.Post(strings.TrimRight(serverURL, "/")+"/api/ingest", "application/json", bytes.NewReader(b))
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
