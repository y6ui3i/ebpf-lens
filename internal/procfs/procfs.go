// Package procfs は /proc から答え合わせ用の値を読む(主役は eBPF。ここは比較と文脈のため)。
package procfs

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// MemInfo は /proc/meminfo のうち、使用率の計算に要る 2 つ(バイト)。
type MemInfo struct {
	TotalBytes     uint64
	AvailableBytes uint64
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
		fields := strings.Fields(sc.Text()) // 例: "MemAvailable:   24360916 kB"
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
		}
	}
	if m.TotalBytes == 0 {
		return m, fmt.Errorf("MemTotal not found")
	}
	return m, sc.Err()
}

// PSI はカーネルの Pressure Stall Information の累計(マイクロ秒)。
// some: 1 つ以上のタスクが止まっていた時間、full: 全タスクが止まっていた時間。
type PSI struct {
	SomeTotalUs uint64
	FullTotalUs uint64
}

// ReadPSI は /proc/pressure/<resource> を読む(resource は "memory" など)。
func ReadPSI(resource string) (PSI, error) {
	b, err := os.ReadFile("/proc/pressure/" + resource)
	if err != nil {
		return PSI{}, err
	}
	var p PSI
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		// 例: "some avg10=0.00 avg60=0.00 avg300=0.00 total=217"
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
