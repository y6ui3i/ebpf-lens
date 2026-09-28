// Package tcpconn watches outbound TCP connections with eBPF: connect latency (SYN_SENT -> ESTABLISHED) as a
// log2 histogram, failed connects (SYN_SENT -> CLOSE), and retransmitted segments, per destination and per process.
package tcpconn

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -tags linux -cc clang -cflags "-O2 -g -Wall" -target amd64 tcpconn tcpconn.bpf.c -- -I../../../bpf/headers

import (
	"errors"
	"fmt"
	"net/netip"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"

	"github.com/y6ui3i/ebpf-lens/internal/model"
	"github.com/y6ui3i/ebpf-lens/internal/probe"
)

// MaxSlots must match MAX_SLOTS on the BPF side.
const MaxSlots = 27

const afInet6 = 10

// Probe holds the loaded BPF objects and the attached links.
type Probe struct {
	objs  tcpconnObjects
	links []link.Link
	prev  [MaxSlots]uint64
}

// Open loads the BPF programs and attaches them to the socket and TCP tracepoints.
func Open() (*Probe, error) {
	p := &Probe{}
	if err := loadTcpconnObjects(&p.objs, nil); err != nil {
		return nil, fmt.Errorf("load bpf objects: %w", err)
	}
	for _, prog := range []*ebpf.Program{p.objs.HandleSetState, p.objs.HandleRetransmit} {
		l, err := link.AttachTracing(link.TracingOptions{Program: prog})
		if err != nil {
			p.Close()
			return nil, fmt.Errorf("attach %s: %w", prog, err)
		}
		p.links = append(p.links, l)
	}
	return p, nil
}

// Delta returns, per slot, how many connects completed with that latency since the previous call.
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

// Procs reads and clears the per-process aggregates and merges them by name. In the result, Wait* means
// "connect latency of the connections this process opened" (count, total, max) and ConnectFails how many failed.
func (p *Probe) Procs(label func(tgid uint32, comm string) string) ([]model.ProcStat, error) {
	var (
		key  tcpconnProcKey
		val  tcpconnProcVal
		keys []tcpconnProcKey
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
		s.WaitCount += val.Connects
		s.WaitNs += val.LatNs
		s.WaitMaxNs = max(s.WaitMaxNs, val.LatMaxNs)
		s.ConnectFails += val.Fails
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

// Dests reads and clears the per-destination aggregates.
func (p *Probe) Dests() ([]model.NetDest, error) {
	var (
		key  tcpconnDestKey
		val  tcpconnDestVal
		keys []tcpconnDestKey
		out  []model.NetDest
	)
	it := p.objs.Dests.Iterate()
	for it.Next(&key, &val) {
		keys = append(keys, key)
		out = append(out, model.NetDest{
			Addr: addrString(key), Port: key.Port,
			Connects: val.Connects, Fails: val.Fails, Retrans: val.Retrans, LatNs: val.LatNs, LatMaxNs: val.LatMaxNs,
		})
	}
	if err := it.Err(); err != nil {
		return nil, fmt.Errorf("iterate dests: %w", err)
	}
	for i := range keys {
		_ = p.objs.Dests.Delete(&keys[i])
	}
	return out, nil
}

// addrString renders the destination address. The BPF side stores a v4 address in the last word, network byte order.
func addrString(k tcpconnDestKey) string {
	if k.Family == afInet6 {
		var b [16]byte
		for i, w := range k.Addr {
			b[i*4], b[i*4+1], b[i*4+2], b[i*4+3] = byte(w), byte(w>>8), byte(w>>16), byte(w>>24)
		}
		return netip.AddrFrom16(b).Unmap().String()
	}
	w := k.Addr[3]
	return netip.AddrFrom4([4]byte{byte(w), byte(w >> 8), byte(w >> 16), byte(w >> 24)}).String()
}

const maxPids = 5

// Close detaches the links and releases the BPF objects.
func (p *Probe) Close() error {
	var errs []error
	for _, l := range p.links {
		errs = append(errs, l.Close())
	}
	errs = append(errs, p.objs.Close())
	return errors.Join(errs...)
}
