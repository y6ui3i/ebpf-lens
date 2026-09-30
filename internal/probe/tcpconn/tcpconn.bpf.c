//go:build ignore

// tcpconn: outbound TCP connections seen from the socket state machine (inet_sock_set_state) plus
// retransmissions (tcp_retransmit_skb). The tcpconnect / tcpconnlat / tcpretrans ideas from bcc in one probe:
//   - a connect() takes the socket to SYN_SENT in the connecting process's context: remember when and who
//   - SYN_SENT -> ESTABLISHED is a successful connect; the time in between is the connect latency (a log2 µs
//     histogram, plus per-destination and per-process totals). A p99 at or above 1 s means the SYN itself was
//     retransmitted (the initial RTO), i.e. packets are being lost on the way to that destination
//   - SYN_SENT -> CLOSE is a failed connect (refused, unreachable, timed out)
//   - tcp_retransmit_skb counts retransmitted segments per destination (packet loss or a congested path)
//   - kfree_skb: every packet the kernel drops, with the kernel's own reason (enum skb_drop_reason: a full
//     accept queue, a firewall rule, no route, a duplicate segment...). Counted per reason; for the reasons that
//     are not everyday housekeeping, also per (reason, addresses, ports) so the row says who sent what to where.
//     A drop runs in softirq context most of the time, so the current task says nothing about the owner; the
//     listening process is learned separately (inet_csk_listen_start) and joined by port in user space

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_endian.h>

#define MAX_SLOTS 27
#define TASK_COMM_LEN 16
#define AF_INET 2
#define AF_INET6 10
#define IPPROTO_TCP 6
#define IPPROTO_UDP 17
#define MAX_REASONS 256
#define HDR_UNSET 0xffff // an skb header offset that was never set

char LICENSE[] SEC("license") = "Dual BSD/GPL";

// Reasons that are housekeeping (set by the agent from the kernel's own enum names before loading): counted per
// reason, but no per-flow row. Everything else gets a row with addresses
const volatile u8 noisy[MAX_REASONS];

// The value of TCP_LISTEN_OVERFLOW on this kernel (set by the agent from the enum; 0 disables handle_conn_request)
const volatile u32 listen_overflow_reason;

// One drop flow: reason and the packet's addresses (v4 in [3], v6 in all four; empty when the packet had no IP
// header). The source port is left out on purpose: it is the client's ephemeral port, different for every
// attempt, and would turn one refused service into hundreds of rows
struct drop_key {
	u32 saddr[4];
	u32 daddr[4];
	u32 reason;
	u16 dport;
	u8 family;
	u8 proto;
};

// The process that put a TCP socket into LISTEN, by local port
struct tcp_listener {
	u32 tgid;
	char comm[TASK_COMM_LEN];
};

struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, MAX_REASONS);
	__type(key, u32);
	__type(value, u64);
} drop_reasons SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 4096);
	__type(key, struct drop_key);
	__type(value, u64);
} drop_flows SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 1024);
	__type(key, u32); // local port
	__type(value, struct tcp_listener);
} listeners SEC(".maps");

struct proc_key {
	u32 tgid;
	char comm[TASK_COMM_LEN];
};

struct proc_val {
	u64 connects;
	u64 fails;
	u64 lat_ns;
	u64 lat_max_ns;
	u64 slots[MAX_SLOTS];
};

// Destination: address (v4 in addr[3] with the rest zero, v6 in all four) and port, host byte order for the port
struct dest_key {
	u32 addr[4];
	u16 port;
	u16 family;
};

struct dest_val {
	u64 connects;
	u64 fails;
	u64 retrans;
	u64 lat_ns;
	u64 lat_max_ns;
};

// A connect in progress: when it started and who asked for it
struct start {
	u64 ts;
	u32 tgid;
	char comm[TASK_COMM_LEN];
};

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 16384);
	__type(key, u64); // struct sock *
	__type(value, struct start);
} start SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 4096);
	__type(key, struct proc_key);
	__type(value, struct proc_val);
} procs SEC(".maps");

// Sockets this host connected out on. A retransmit on any other socket belongs to an inbound connection, and is
// filed under the peer's address with port 0 ("clients at addr"): its ephemeral port would only make noise
struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 65536);
	__type(key, u64); // struct sock *
	__type(value, u8);
} outbound SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 8192);
	__type(key, struct dest_key);
	__type(value, struct dest_val);
} dests SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, MAX_SLOTS);
	__type(key, u32);
	__type(value, u64);
} hist SEC(".maps");

static const struct proc_val pzero;
static const struct dest_val dzero;

static __always_inline u32 log2_u32(u32 v)
{
	u32 shift, r;

	r = (v > 0xFFFF) << 4; v >>= r;
	shift = (v > 0xFF) << 3; v >>= shift; r |= shift;
	shift = (v > 0xF) << 2; v >>= shift; r |= shift;
	shift = (v > 0x3) << 1; v >>= shift; r |= shift;
	r |= (v >> 1);
	return r;
}

static __always_inline u32 log2_u64(u64 v)
{
	u32 hi = v >> 32;

	return hi ? log2_u32(hi) + 32 : log2_u32(v);
}

static __always_inline void dest_of(const struct sock *sk, struct dest_key *k)
{
	k->family = BPF_CORE_READ(sk, __sk_common.skc_family);
	k->port = bpf_ntohs(BPF_CORE_READ(sk, __sk_common.skc_dport));
	if (k->family == AF_INET6)
		BPF_CORE_READ_INTO(&k->addr, sk, __sk_common.skc_v6_daddr.in6_u.u6_addr32);
	else
		k->addr[3] = BPF_CORE_READ(sk, __sk_common.skc_daddr);
}

static __always_inline struct dest_val *dest_val_of(const struct sock *sk)
{
	struct dest_key k = {};
	struct dest_val *v;

	dest_of(sk, &k);
	v = bpf_map_lookup_elem(&dests, &k);
	if (v)
		return v;
	bpf_map_update_elem(&dests, &k, &dzero, BPF_NOEXIST);
	return bpf_map_lookup_elem(&dests, &k);
}

static __always_inline struct proc_val *proc_val_of(const struct start *s)
{
	struct proc_key k = {};
	struct proc_val *v;

	k.tgid = s->tgid;
	__builtin_memcpy(k.comm, s->comm, sizeof(k.comm));
	v = bpf_map_lookup_elem(&procs, &k);
	if (v)
		return v;
	bpf_map_update_elem(&procs, &k, &pzero, BPF_NOEXIST);
	return bpf_map_lookup_elem(&procs, &k);
}

SEC("tp_btf/inet_sock_set_state")
int BPF_PROG(handle_set_state, const struct sock *sk, int oldstate, int newstate)
{
	u64 key = (u64)sk;
	struct start *s;
	u64 now, delta;
	u32 slot, *cnt_dummy;
	u64 *cnt;
	struct proc_val *pv;
	struct dest_val *dv;

	if (BPF_CORE_READ(sk, sk_protocol) != IPPROTO_TCP)
		return 0;

	if (newstate == BPF_TCP_SYN_SENT) {
		// connect() runs in the caller's context
		struct task_struct *t = (struct task_struct *)bpf_get_current_task_btf();
		struct start st = {};

		st.ts = bpf_ktime_get_ns();
		st.tgid = t->tgid;
		bpf_probe_read_kernel_str(st.comm, sizeof(st.comm), t->group_leader->comm);
		bpf_map_update_elem(&start, &key, &st, BPF_ANY);
		return 0;
	}
	if (newstate == BPF_TCP_CLOSE)
		bpf_map_delete_elem(&outbound, &key);
	if (oldstate == BPF_TCP_LISTEN && newstate == BPF_TCP_CLOSE) {
		u32 port = BPF_CORE_READ(sk, __sk_common.skc_num);

		bpf_map_delete_elem(&listeners, &port);
	}
	if (oldstate != BPF_TCP_SYN_SENT)
		return 0;
	s = bpf_map_lookup_elem(&start, &key);
	if (!s)
		return 0;

	if (newstate == BPF_TCP_ESTABLISHED) {
		u8 one = 1;

		bpf_map_update_elem(&outbound, &key, &one, BPF_ANY);
		now = bpf_ktime_get_ns();
		delta = now - s->ts;
		slot = log2_u64(delta / 1000);
		if (slot >= MAX_SLOTS)
			slot = MAX_SLOTS - 1;
		cnt = bpf_map_lookup_elem(&hist, &slot);
		if (cnt)
			*cnt += 1;
		dv = dest_val_of(sk);
		if (dv) {
			__sync_fetch_and_add(&dv->connects, 1);
			__sync_fetch_and_add(&dv->lat_ns, delta);
			if (delta > dv->lat_max_ns)
				dv->lat_max_ns = delta;
		}
		pv = proc_val_of(s);
		if (pv) {
			__sync_fetch_and_add(&pv->connects, 1);
			__sync_fetch_and_add(&pv->lat_ns, delta);
			if (delta > pv->lat_max_ns)
				pv->lat_max_ns = delta;
			barrier_var(slot);
			if (slot < MAX_SLOTS)
				__sync_fetch_and_add(&pv->slots[slot], 1);
		}
	} else if (newstate == BPF_TCP_CLOSE) {
		// Refused, unreachable, or timed out: the socket goes straight from SYN_SENT to CLOSE
		dv = dest_val_of(sk);
		if (dv)
			__sync_fetch_and_add(&dv->fails, 1);
		pv = proc_val_of(s);
		if (pv)
			__sync_fetch_and_add(&pv->fails, 1);
	} else {
		return 0; // SYN_RECV etc.: keep waiting
	}
	bpf_map_delete_elem(&start, &key);
	(void)cnt_dummy;
	return 0;
}

SEC("tp_btf/tcp_retransmit_skb")
int BPF_PROG(handle_retransmit, const struct sock *sk, const struct sk_buff *skb)
{
	u64 key = (u64)sk;
	struct dest_key k = {};
	struct dest_val *dv;

	dest_of(sk, &k);
	if (!bpf_map_lookup_elem(&outbound, &key))
		k.port = 0; // inbound connection: all clients at this address in one row
	dv = bpf_map_lookup_elem(&dests, &k);
	if (!dv) {
		bpf_map_update_elem(&dests, &k, &dzero, BPF_NOEXIST);
		dv = bpf_map_lookup_elem(&dests, &k);
	}
	if (dv)
		__sync_fetch_and_add(&dv->retrans, 1);
	return 0;
}

// listen() runs in the caller's context. Entering LISTEN does not fire inet_sock_set_state (the kernel stores
// that state directly), so the function that does it is traced instead; leaving LISTEN does fire it (see above)
SEC("fentry/inet_csk_listen_start")
int BPF_PROG(handle_listen, struct sock *sk)
{
	struct task_struct *t = (struct task_struct *)bpf_get_current_task_btf();
	struct tcp_listener l = {};
	u32 port = BPF_CORE_READ(sk, __sk_common.skc_num);

	l.tgid = t->tgid;
	bpf_probe_read_kernel_str(l.comm, sizeof(l.comm), t->group_leader->comm);
	bpf_map_update_elem(&listeners, &port, &l, BPF_ANY);
	return 0;
}

// parse_skb fills the addresses, ports and protocol from the packet's own headers. The network header offset is
// trusted only if the first nibble there is an IP version; the transport header offset is used when it was set,
// otherwise it is computed from the IP header (a packet dropped before the transport layer saw it)
static __always_inline void parse_skb(const struct sk_buff *skb, struct drop_key *k)
{
	unsigned char *head = BPF_CORE_READ(skb, head);
	u16 nh = BPF_CORE_READ(skb, network_header);
	u16 th = BPF_CORE_READ(skb, transport_header);
	u32 thoff;
	u8 first;
	u16 ports[2];

	if (!head || nh == HDR_UNSET)
		return;
	if (bpf_probe_read_kernel(&first, sizeof(first), head + nh))
		return;
	if ((first >> 4) == 4) {
		struct iphdr ip;

		if (bpf_probe_read_kernel(&ip, sizeof(ip), head + nh))
			return;
		k->family = AF_INET;
		k->saddr[3] = ip.saddr;
		k->daddr[3] = ip.daddr;
		k->proto = ip.protocol;
		thoff = nh + (u32)(ip.ihl & 0xf) * 4;
	} else if ((first >> 4) == 6) {
		struct ipv6hdr ip6;

		if (bpf_probe_read_kernel(&ip6, sizeof(ip6), head + nh))
			return;
		k->family = AF_INET6;
		__builtin_memcpy(k->saddr, ip6.saddr.in6_u.u6_addr32, sizeof(k->saddr));
		__builtin_memcpy(k->daddr, ip6.daddr.in6_u.u6_addr32, sizeof(k->daddr));
		k->proto = ip6.nexthdr;
		thoff = nh + sizeof(ip6);
	} else {
		return;
	}
	if (th != HDR_UNSET && th > nh)
		thoff = th;
	if (k->proto != IPPROTO_TCP && k->proto != IPPROTO_UDP)
		return;
	if (bpf_probe_read_kernel(ports, sizeof(ports), head + thoff))
		return;
	k->dport = bpf_ntohs(ports[1]);
}

static const u64 zero64;

// record_drop counts one drop under its reason and, unless the reason is housekeeping, under its flow
static __always_inline void record_drop(u32 idx, const struct sk_buff *skb)
{
	struct drop_key k = {};
	u64 *cnt;

	if (idx >> 16 || idx >= MAX_REASONS)
		idx = MAX_REASONS - 1; // a subsystem's own reason space (mac80211 etc.): one bucket for all of them
	cnt = bpf_map_lookup_elem(&drop_reasons, &idx);
	if (cnt)
		*cnt += 1;
	// The verifier forgets the bound once idx has been passed to a map helper: re-establish it before indexing
	barrier_var(idx);
	if (idx >= MAX_REASONS || noisy[idx])
		return;
	k.reason = idx;
	parse_skb(skb, &k);
	cnt = bpf_map_lookup_elem(&drop_flows, &k);
	if (!cnt) {
		bpf_map_update_elem(&drop_flows, &k, &zero64, BPF_NOEXIST);
		cnt = bpf_map_lookup_elem(&drop_flows, &k);
	}
	if (cnt)
		__sync_fetch_and_add(cnt, 1);
}

// Every dropped packet, with the kernel's reason. Kernels since 6.11 pass a fourth argument (the receiving
// socket); only the first three are used, so this loads on 6.6 as well
SEC("tp_btf/kfree_skb")
int BPF_PROG(handle_drop, struct sk_buff *skb, void *location, enum skb_drop_reason reason)
{
	record_drop(reason, skb);
	return 0;
}

// A SYN that arrives while the listener's accept queue is full is dropped inside tcp_conn_request, but its
// caller frees it with consume_skb, so kfree_skb never sees it (the kernel only names TCP_LISTEN_OVERFLOW for
// the handshake's final ACK). The queue being full when tcp_conn_request returns is that drop: record it under
// the same reason, so "the server is not accepting fast enough" shows up whichever packet the kernel refused
SEC("fexit/tcp_conn_request")
int BPF_PROG(handle_conn_request, struct request_sock_ops *rsk_ops, const struct tcp_request_sock_ops *af_ops,
	     struct sock *sk, struct sk_buff *skb, int ret)
{
	u32 backlog, limit;

	if (!listen_overflow_reason)
		return 0;
	backlog = BPF_CORE_READ(sk, sk_ack_backlog);
	limit = BPF_CORE_READ(sk, sk_max_ack_backlog);
	if (backlog <= limit)
		return 0;
	record_drop(listen_overflow_reason, skb);
	return 0;
}
