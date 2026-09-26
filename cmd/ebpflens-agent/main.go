// ebpflens-agent は eBPF プローブの値を一定間隔で JSON Lines として標準出力に書く。
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/yoshiharu-ishii/ebpf-lens/internal/probe/runqlat"
)

// Sample は 1 区間ぶんのヒストグラム。Slots[i] は [2^i, 2^(i+1)) µs の件数。
type Sample struct {
	Time  time.Time `json:"time"`
	Probe string    `json:"probe"`
	Unit  string    `json:"unit"`
	Slots []uint64  `json:"slots"`
}

func main() {
	interval := flag.Duration("interval", time.Second, "集計間隔")
	count := flag.Int("count", 0, "出力回数(0 なら無限)")
	text := flag.Bool("text", false, "JSON の代わりに runqlat 風のテキストヒストグラムを出す")
	flag.Parse()

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
			if err := enc.Encode(Sample{Time: now, Probe: "runqlat", Unit: "usecs", Slots: slots[:]}); err != nil {
				log.Fatal(err)
			}
		}
	}
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
