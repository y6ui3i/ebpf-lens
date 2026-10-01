// probe-only loads a chosen set of probes and drains them once a second, printing a short line. A debugging aid
// for isolating a probe (or a pair of probes) that misbehaves on a host; it is not installed by make install.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/y6ui3i/ebpf-lens/internal/probe/biolat"
	"github.com/y6ui3i/ebpf-lens/internal/probe/fileops"
	"github.com/y6ui3i/ebpf-lens/internal/probe/irqlat"
	"github.com/y6ui3i/ebpf-lens/internal/probe/lockwait"
	"github.com/y6ui3i/ebpf-lens/internal/probe/memstall"
	"github.com/y6ui3i/ebpf-lens/internal/probe/pgfault"
	"github.com/y6ui3i/ebpf-lens/internal/probe/runqlat"
	"github.com/y6ui3i/ebpf-lens/internal/probe/tcpconn"
)

type reader struct {
	name  string
	read  func() (string, error)
	close func() error
}

func open(name string) (reader, error) {
	switch name {
	case "runqlat":
		p, err := runqlat.Open()
		if err != nil {
			return reader{}, err
		}
		return reader{name, func() (string, error) {
			if _, err := p.Delta(); err != nil {
				return "", err
			}
			ps, err := p.Procs(nil)
			return fmt.Sprintf("procs=%d", len(ps)), err
		}, p.Close}, nil
	case "memstall":
		p, err := memstall.Open()
		if err != nil {
			return reader{}, err
		}
		return reader{name, func() (string, error) {
			if _, err := p.Delta(); err != nil {
				return "", err
			}
			ps, err := p.Procs(nil)
			return fmt.Sprintf("procs=%d", len(ps)), err
		}, p.Close}, nil
	case "biolat":
		p, err := biolat.Open()
		if err != nil {
			return reader{}, err
		}
		return reader{name, func() (string, error) {
			if _, err := p.Delta(); err != nil {
				return "", err
			}
			if _, err := p.Procs(nil); err != nil {
				return "", err
			}
			ds, err := p.Devices()
			return fmt.Sprintf("devs=%d", len(ds)), err
		}, p.Close}, nil
	case "tcpconn":
		p, err := tcpconn.Open()
		if err != nil {
			return reader{}, err
		}
		return reader{name, func() (string, error) {
			if _, err := p.Delta(); err != nil {
				return "", err
			}
			if _, err := p.Procs(nil); err != nil {
				return "", err
			}
			if _, err := p.Dests(); err != nil {
				return "", err
			}
			d, f, err := p.Drops()
			return fmt.Sprintf("drops=%d flows=%d", len(d), len(f)), err
		}, p.Close}, nil
	case "fileops":
		p, err := fileops.Open()
		if err != nil {
			return reader{}, err
		}
		return reader{name, func() (string, error) {
			if _, err := p.Delta(); err != nil {
				return "", err
			}
			if _, err := p.Procs(nil); err != nil {
				return "", err
			}
			if _, _, err := p.Opens(nil); err != nil {
				return "", err
			}
			fs, err := p.Files()
			return fmt.Sprintf("fsyncs=%d", len(fs)), err
		}, p.Close}, nil
	case "lockwait":
		p, err := lockwait.Open()
		if err != nil {
			return reader{}, err
		}
		return reader{name, func() (string, error) {
			r, err := p.Read(nil)
			return fmt.Sprintf("user=%.1fms parked=%.1fms", float64(r.Stat.UserNs)/1e6, float64(r.Parked)/1e6), err
		}, p.Close}, nil
	case "pgfault":
		p, err := pgfault.Open()
		if err != nil {
			return reader{}, err
		}
		return reader{name, func() (string, error) {
			if _, err := p.Delta(); err != nil {
				return "", err
			}
			_, tot, err := p.Procs(nil)
			return fmt.Sprintf("minor=%d major=%d stall=%.1fms", tot.Minor, tot.Major, float64(tot.MajorNs)/1e6), err
		}, p.Close}, nil
	case "irqlat":
		p, err := irqlat.Open()
		if err != nil {
			return reader{}, err
		}
		return reader{name, func() (string, error) {
			if _, err := p.Delta(); err != nil {
				return "", err
			}
			st, err := p.Read()
			var soft, hard uint64
			for _, c := range st.CPUs {
				soft += c.SoftirqNs
				hard += c.IRQNs
			}
			return fmt.Sprintf("softirq=%.1fms irq=%.1fms", float64(soft)/1e6, float64(hard)/1e6), err
		}, p.Close}, nil
	}
	return reader{}, fmt.Errorf("unknown probe %q", name)
}

func main() {
	which := flag.String("probe", "pgfault", "comma-separated: runqlat, memstall, biolat, tcpconn, fileops, lockwait, pgfault, irqlat")
	count := flag.Int("count", 0, "number of seconds (0: until interrupted)")
	flag.Parse()

	var readers []reader
	for _, name := range strings.Split(*which, ",") {
		r, err := open(strings.TrimSpace(name))
		if err != nil {
			log.Fatalf("%s: %v", name, err)
		}
		defer r.close()
		readers = append(readers, r)
		log.Printf("%s: attached", r.name)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for n := 0; *count == 0 || n < *count; n++ {
		select {
		case <-sig:
			return
		case now := <-tick.C:
			var parts []string
			for _, r := range readers {
				s, err := r.read()
				if err != nil {
					log.Fatalf("%s: %v", r.name, err)
				}
				parts = append(parts, r.name+"["+s+"]")
			}
			fmt.Printf("%s %s\n", now.Format(time.TimeOnly), strings.Join(parts, " "))
		}
	}
}
