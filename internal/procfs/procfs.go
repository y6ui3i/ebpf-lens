// Package procfs reads values from /proc for cross-checking (eBPF is the main source; this is for comparison and context).
package procfs

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// MemInfo holds the /proc/meminfo values needed to compute usage and swap (in bytes).
type MemInfo struct {
	TotalBytes     uint64
	AvailableBytes uint64
	SwapTotalBytes uint64
	SwapFreeBytes  uint64
}

func ReadMemInfo() (MemInfo, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return MemInfo{}, err
	}
	defer f.Close()
	var m MemInfo
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text()) // e.g. "MemAvailable:   24360916 kB"
		if len(fields) < 2 {
			continue
		}
		kb, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			m.TotalBytes = kb * 1024
		case "MemAvailable:":
			m.AvailableBytes = kb * 1024
		case "SwapTotal:":
			m.SwapTotalBytes = kb * 1024
		case "SwapFree:":
			m.SwapFreeBytes = kb * 1024
		}
	}
	if m.TotalBytes == 0 {
		return m, fmt.Errorf("MemTotal not found")
	}
	return m, sc.Err()
}

// VMStat holds the cumulative swap counters from /proc/vmstat (pages).
type VMStat struct {
	SwapIn  uint64 // pswpin
	SwapOut uint64 // pswpout
}

// ReadVMStat reads the swap counters.
func ReadVMStat() (VMStat, error) {
	f, err := os.Open("/proc/vmstat")
	if err != nil {
		return VMStat{}, err
	}
	defer f.Close()
	var v VMStat
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) != 2 {
			continue
		}
		n, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "pswpin":
			v.SwapIn = n
		case "pswpout":
			v.SwapOut = n
		}
	}
	return v, sc.Err()
}

// PSI is the kernel's cumulative Pressure Stall Information (microseconds).
// some: time at least one task was stalled; full: time all tasks were stalled.
type PSI struct {
	SomeTotalUs uint64
	FullTotalUs uint64
}

// ReadPSI reads /proc/pressure/<resource> (resource is "memory", etc.).
func ReadPSI(resource string) (PSI, error) {
	b, err := os.ReadFile("/proc/pressure/" + resource)
	if err != nil {
		return PSI{}, err
	}
	var p PSI
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		// e.g. "some avg10=0.00 avg60=0.00 avg300=0.00 total=217"
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		for _, f := range fields[1:] {
			v, ok := strings.CutPrefix(f, "total=")
			if !ok {
				continue
			}
			n, err := strconv.ParseUint(v, 10, 64)
			if err != nil {
				return p, fmt.Errorf("parse %q: %w", line, err)
			}
			switch fields[0] {
			case "some":
				p.SomeTotalUs = n
			case "full":
				p.FullTotalUs = n
			}
		}
	}
	return p, nil
}
