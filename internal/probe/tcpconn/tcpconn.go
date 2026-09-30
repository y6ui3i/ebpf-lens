// Package tcpconn watches outbound TCP connections with eBPF: connect latency (SYN_SENT -> ESTABLISHED) as a
// log2 histogram, failed connects (SYN_SENT -> CLOSE), and retransmitted segments, per destination and per process.
// It also counts every packet the kernel drops, with the kernel's own reason (kfree_skb).
package tcpconn

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -tags linux -cc clang -cflags "-O2 -g -Wall" -target amd64 tcpconn tcpconn.bpf.c -- -I../../../bpf/headers

import (
	"errors"
	"fmt"
	"net/netip"
	"strings"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/btf"
	"github.com/cilium/ebpf/link"

	"github.com/y6ui3i/ebpf-lens/internal/model"
	"github.com/y6ui3i/ebpf-lens/internal/netdrop"
	"github.com/y6ui3i/ebpf-lens/internal/probe"
)

// MaxSlots must match MAX_SLOTS on the BPF side.
const MaxSlots = 27

// maxReasons must match MAX_REASONS on the BPF side; the last index collects the subsystem-specific reasons.
const maxReasons = 256

const (
	afInet6     = 10
	ipprotoTCP  = 6
	ipprotoUDP  = 17
	ipprotoICMP = 1
)

// Probe holds the loaded BPF objects and the attached links.
type Probe struct {
	objs      tcpconnObjects
	links     []link.Link
	prev      [MaxSlots]uint64
	prevDrops [maxReasons]uint64
	reasons   map[uint32]string // drop reason value -> name, from the running kernel's BTF
	// Warning is set when an optional program could not be attached (the probe works without it)
	Warning string
}

// Open loads the BPF programs and attaches them to the socket and TCP tracepoints.
func Open() (*Probe, error) {
	p := &Probe{reasons: reasonNames()}
	spec, err := loadTcpconn()
	if err != nil {
		return nil, fmt.Errorf("load bpf spec: %w", err)
	}
	// Tell the kernel side which reasons are housekeeping, by the names this kernel gives them
	var noisy [maxReasons]uint8
	for v, name := range p.reasons {
		if v < maxReasons && netdrop.Tier(name) == netdrop.TierNoise {
			noisy[v] = 1
		}
	}
	if err := spec.Variables["noisy"].Set(noisy); err != nil {
		return nil, fmt.Errorf("set noisy reasons: %w", err)
	}
	var overflow uint32
	for v, name := range p.reasons {
		if name == "TCP_LISTEN_OVERFLOW" {
			overflow = v
		}
	}
	if err := spec.Variables["listen_overflow_reason"].Set(overflow); err != nil {
		return nil, fmt.Errorf("set listen overflow reason: %w", err)
	}
	if err := spec.LoadAndAssign(&p.objs, nil); err != nil {
		return nil, fmt.Errorf("load bpf objects: %w", err)
	}
	for _, prog := range []*ebpf.Program{p.objs.HandleSetState, p.objs.HandleRetransmit, p.objs.HandleListen, p.objs.HandleDrop} {
		l, err := link.AttachTracing(link.TracingOptions{Program: prog})
		if err != nil {
			p.Close()
			return nil, fmt.Errorf("attach %s: %w", prog, err)
		}
		p.links = append(p.links, l)
	}
	// Optional: a kernel that inlined tcp_conn_request has nothing to attach to, and the rest still works
	if overflow == 0 {
		p.Warning = "TCP_LISTEN_OVERFLOW is not in this kernel's drop reasons; SYNs refused by a full accept queue go uncounted"
	} else if l, err := link.AttachTracing(link.TracingOptions{Program: p.objs.HandleConnRequest}); err != nil {
		p.Warning = fmt.Sprintf("attach tcp_conn_request: %v; SYNs refused by a full accept queue go uncounted", err)
	} else {
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
	return ipString(k.Family == afInet6, k.Addr)
}

func ipString(v6 bool, addr [4]uint32) string {
	if v6 {
		var b [16]byte
		for i, w := range addr {
			b[i*4], b[i*4+1], b[i*4+2], b[i*4+3] = byte(w), byte(w>>8), byte(w>>16), byte(w>>24)
		}
		return netip.AddrFrom16(b).Unmap().String()
	}
	w := addr[3]
	return netip.AddrFrom4([4]byte{byte(w), byte(w >> 8), byte(w >> 16), byte(w >> 24)}).String()
}

// Drops reads the packets dropped since the previous call: every reason with its count, and the flows (reason
// and addresses) of the reasons that are not housekeeping. Flows toward a port a local process listens on carry
// that process's name.
func (p *Probe) Drops() ([]model.NetDrop, []model.NetDropFlow, error) {
	var drops []model.NetDrop
	for idx := uint32(0); idx < maxReasons; idx++ {
		var perCPU []uint64
		if err := p.objs.DropReasons.Lookup(idx, &perCPU); err != nil {
			return nil, nil, fmt.Errorf("lookup reason %d: %w", idx, err)
		}
		var sum uint64
		for _, v := range perCPU {
			sum += v
		}
		if d := sum - p.prevDrops[idx]; d > 0 {
			name := p.reasonName(idx)
			drops = append(drops, model.NetDrop{Reason: name, Count: d, Tier: netdrop.Tier(name)})
		}
		p.prevDrops[idx] = sum
	}

	listeners := map[uint16]string{}
	var (
		lport uint32
		l     tcpconnTcpListener
	)
	it := p.objs.Listeners.Iterate()
	for it.Next(&lport, &l) {
		listeners[uint16(lport)] = probe.CString(l.Comm[:])
	}
	if err := it.Err(); err != nil {
		return nil, nil, fmt.Errorf("iterate listeners: %w", err)
	}

	var (
		key   tcpconnDropKey
		cnt   uint64
		keys  []tcpconnDropKey
		flows []model.NetDropFlow
	)
	it = p.objs.DropFlows.Iterate()
	for it.Next(&key, &cnt) {
		keys = append(keys, key)
		f := model.NetDropFlow{Reason: p.reasonName(key.Reason), Count: cnt, Dport: key.Dport}
		if key.Family != 0 {
			f.Src, f.Dst = ipString(key.Family == afInet6, key.Saddr), ipString(key.Family == afInet6, key.Daddr)
		}
		switch key.Proto {
		case ipprotoTCP:
			f.Proto = "tcp"
			f.Listener = listeners[key.Dport] // a port this host listens on: the drop was on the way in to that process
		case ipprotoUDP:
			f.Proto = "udp"
		case ipprotoICMP:
			f.Proto = "icmp"
		}
		flows = append(flows, f)
	}
	if err := it.Err(); err != nil {
		return nil, nil, fmt.Errorf("iterate drop flows: %w", err)
	}
	for i := range keys {
		_ = p.objs.DropFlows.Delete(&keys[i])
	}
	return drops, flows, nil
}

func (p *Probe) reasonName(idx uint32) string {
	if idx == maxReasons-1 {
		return "OTHER_SUBSYSTEM"
	}
	if name, ok := p.reasons[idx]; ok {
		return name
	}
	return fmt.Sprintf("REASON_%d", idx)
}

// reasonNames reads enum skb_drop_reason from the running kernel's BTF, so the names match this kernel exactly
// (the numbering shifts between versions). Without BTF the reasons are reported by number.
func reasonNames() map[uint32]string {
	out := map[uint32]string{}
	spec, err := btf.LoadKernelSpec()
	if err != nil {
		return out
	}
	var e *btf.Enum
	if err := spec.TypeByName("skb_drop_reason", &e); err != nil {
		return out
	}
	for _, v := range e.Values {
		out[uint32(v.Value)] = strings.TrimPrefix(v.Name, "SKB_DROP_REASON_")
	}
	return out
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
