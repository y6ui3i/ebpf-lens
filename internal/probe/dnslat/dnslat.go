// Package dnslat measures name resolution as applications experience it: a uprobe on glibc's getaddrinfo gives
// the name, the time the call took and its EAI_* result, per name and per process.
package dnslat

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -tags linux -cc clang -cflags "-O2 -g -Wall" -target amd64 dnslat dnslat.bpf.c -- -I../../../bpf/headers

import (
	"errors"
	"fmt"
	"os"

	"github.com/cilium/ebpf/link"

	"github.com/y6ui3i/ebpf-lens/internal/model"
	"github.com/y6ui3i/ebpf-lens/internal/probe"
)

// MaxSlots must match MAX_SLOTS on the BPF side.
const MaxSlots = 27

// ErrNoLibc means no glibc was found at the usual paths.
var ErrNoLibc = errors.New("libc.so.6 not found")

var libcPaths = []string{
	"/usr/lib/x86_64-linux-gnu/libc.so.6",
	"/lib/x86_64-linux-gnu/libc.so.6",
	"/usr/lib64/libc.so.6",
	"/lib64/libc.so.6",
	"/usr/lib/aarch64-linux-gnu/libc.so.6",
}

// FindLibc returns the host's glibc path, or ErrNoLibc.
func FindLibc() (string, error) {
	for _, p := range libcPaths {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	return "", ErrNoLibc
}

// Probe holds the loaded BPF objects and the attached uprobes.
type Probe struct {
	objs  dnslatObjects
	links []link.Link
	prev  [MaxSlots]uint64
}

// Open loads the programs and attaches them to getaddrinfo in the glibc at path, as multi-uprobe BPF links
// (kernel 6.6+, CAP_PERFMON; the same reasoning as the GPU probe, see docs/adr/0003).
func Open(path string) (*Probe, error) {
	p := &Probe{}
	if err := loadDnslatObjects(&p.objs, nil); err != nil {
		return nil, fmt.Errorf("load bpf objects: %w", err)
	}
	ex, err := link.OpenExecutable(path)
	if err != nil {
		p.Close()
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	syms := []string{"getaddrinfo"}
	l, err := ex.UprobeMulti(syms, p.objs.HandleGai, nil)
	if err != nil {
		p.Close()
		return nil, fmt.Errorf("uprobe getaddrinfo: %w", err)
	}
	p.links = append(p.links, l)
	r, err := ex.UretprobeMulti(syms, p.objs.HandleGaiRet, nil)
	if err != nil {
		p.Close()
		return nil, fmt.Errorf("uretprobe getaddrinfo: %w", err)
	}
	p.links = append(p.links, r)
	return p, nil
}

// Delta returns, per slot, how many lookups completed with that latency since the previous call.
func (p *Probe) Delta() ([MaxSlots]uint64, error) {
	var out [MaxSlots]uint64
	for slot := uint32(0); slot < MaxSlots; slot++ {
		var perCPU []uint64
		if err := p.objs.Hist.Lookup(slot, &perCPU); err != nil {
			return out, fmt.Errorf("lookup slot %d: %w", slot, err)
		}
		var sum uint64
		for _, v := range perCPU {
			sum += v
		}
		out[slot] = sum - p.prev[slot]
		p.prev[slot] = sum
	}
	return out, nil
}

// Procs reads and clears the per-process aggregates. In the result, Wait* means "time spent in getaddrinfo"
// (count, total, max) and LookupFails how many of those lookups failed.
func (p *Probe) Procs(label func(tgid uint32, comm string) string) ([]model.ProcStat, error) {
	var (
		key  dnslatProcKey
		val  dnslatProcVal
		keys []dnslatProcKey
	)
	byComm := map[string]*model.ProcStat{}
	it := p.objs.Procs.Iterate()
	for it.Next(&key, &val) {
		keys = append(keys, key)
		comm := probe.CString(key.Comm[:])
		if label != nil {
			comm = label(key.Tgid, comm)
		}
		s, ok := byComm[comm]
		if !ok {
			s = &model.ProcStat{Comm: comm, Slots: make([]uint64, MaxSlots)}
			byComm[comm] = s
		}
		s.Procs++
		if len(s.Pids) < maxPids {
			s.Pids = append(s.Pids, key.Tgid)
		}
		s.WaitCount += val.Lookups
		s.WaitNs += val.LatNs
		s.WaitMaxNs = max(s.WaitMaxNs, val.LatMaxNs)
		s.LookupFails += val.Fails
		for i, c := range val.Slots {
			s.Slots[i] += c
		}
	}
	if err := it.Err(); err != nil {
		return nil, fmt.Errorf("iterate procs: %w", err)
	}
	for i := range keys {
		_ = p.objs.Procs.Delete(&keys[i])
	}
	out := make([]model.ProcStat, 0, len(byComm))
	for _, s := range byComm {
		out = append(out, *s)
	}
	return out, nil
}

// Names reads and clears the per-name aggregates.
func (p *Probe) Names() ([]model.DNSName, error) {
	var (
		key  dnslatNameKey
		val  dnslatNameVal
		keys []dnslatNameKey
		out  []model.DNSName
	)
	it := p.objs.Names.Iterate()
	for it.Next(&key, &val) {
		keys = append(keys, key)
		out = append(out, model.DNSName{
			Name: probe.CString(key.Name[:]), Lookups: val.Lookups, Fails: val.Fails,
			LatNs: val.LatNs, LatMaxNs: val.LatMaxNs, LastError: ErrorName(val.LastErr),
		})
	}
	if err := it.Err(); err != nil {
		return nil, fmt.Errorf("iterate names: %w", err)
	}
	for i := range keys {
		_ = p.objs.Names.Delete(&keys[i])
	}
	return out, nil
}

// ErrorName maps glibc's EAI_* codes (netdb.h) to their names; "" for success.
func ErrorName(rc int32) string {
	switch rc {
	case 0:
		return ""
	case -2:
		return "NONAME" // the name does not exist (NXDOMAIN) or has no address
	case -3:
		return "AGAIN" // temporary failure: the server did not answer in time
	case -4:
		return "FAIL" // non-recoverable failure (SERVFAIL, refused)
	case -5:
		return "NODATA"
	case -6:
		return "FAMILY"
	case -8:
		return "SERVICE"
	case -9:
		return "ADDRFAMILY"
	case -10:
		return "MEMORY"
	case -11:
		return "SYSTEM"
	default:
		return fmt.Sprintf("EAI_%d", rc)
	}
}

const maxPids = 5

// Close detaches the uprobes and releases the BPF objects.
func (p *Probe) Close() error {
	var errs []error
	for _, l := range p.links {
		errs = append(errs, l.Close())
	}
	errs = append(errs, p.objs.Close())
	return errors.Join(errs...)
}
