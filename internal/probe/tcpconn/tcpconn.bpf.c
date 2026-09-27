//go:build ignore

// tcpconn: outbound TCP connections seen from the socket state machine (inet_sock_set_state) plus
// retransmissions (tcp_retransmit_skb). The tcpconnect / tcpconnlat / tcpretrans ideas from bcc in one probe:
//   - a connect() takes the socket to SYN_SENT in the connecting process's context: remember when and who
//   - SYN_SENT -> ESTABLISHED is a successful connect; the time in between is the connect latency (a log2 µs
//     histogram, plus per-destination and per-process totals). A p99 at or above 1 s means the SYN itself was
//     retransmitted (the initial RTO), i.e. packets are being lost on the way to that destination
//   - SYN_SENT -> CLOSE is a failed connect (refused, unreachable, timed out)
//   - tcp_retransmit_skb counts retransmitted segments per destination (packet loss or a congested path)

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

char LICENSE[] SEC("license") = "Dual BSD/GPL";

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
