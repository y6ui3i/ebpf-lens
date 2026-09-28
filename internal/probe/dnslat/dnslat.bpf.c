//go:build ignore

// dnslat: name resolution as the application experiences it — a uprobe on glibc's getaddrinfo (entry: which name,
// when; return: how long, and the EAI_* result). Whatever the resolver does underneath (/etc/hosts, nsswitch,
// systemd-resolved, retries to an upstream server) is inside the measured time, which is the point: this is the
// wait the application sat through. Programs that do not resolve through glibc (Go's pure resolver, musl in a
// container) are not seen; see the manual.

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#define MAX_SLOTS 27
#define TASK_COMM_LEN 16
#define NAME_LEN 64

char LICENSE[] SEC("license") = "Dual BSD/GPL";

struct proc_key {
	u32 tgid;
	char comm[TASK_COMM_LEN];
};

struct proc_val {
	u64 lookups;
	u64 fails;
	u64 lat_ns;
	u64 lat_max_ns;
	u64 slots[MAX_SLOTS];
};

struct name_key {
	char name[NAME_LEN];
};

struct name_val {
	u64 lookups;
	u64 fails;
	u64 lat_ns;
	u64 lat_max_ns;
	s32 last_err; // the last non-zero EAI_* code for this name (0: never failed)
	u32 pad;
};

// A lookup in progress on one thread
struct start {
	u64 ts;
	char name[NAME_LEN];
};

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 10240);
	__type(key, u32); // tid
	__type(value, struct start);
} start SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 4096);
	__type(key, struct proc_key);
	__type(value, struct proc_val);
} procs SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 4096);
	__type(key, struct name_key);
	__type(value, struct name_val);
} names SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, MAX_SLOTS);
	__type(key, u32);
	__type(value, u64);
} hist SEC(".maps");

// Zero values live in .rodata: structs with a 27-slot histogram do not belong on the 512-byte stack
static const struct proc_val pzero;
static const struct name_val nzero;

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

// int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **res)
SEC("uprobe.multi")
int BPF_KPROBE(handle_gai, const char *node)
{
	u32 tid = (u32)bpf_get_current_pid_tgid();
	struct start s = {};

	if (!node)
		return 0; // passive lookups (node == NULL) resolve nothing
	s.ts = bpf_ktime_get_ns();
	bpf_probe_read_user_str(s.name, sizeof(s.name), node);
	bpf_map_update_elem(&start, &tid, &s, BPF_ANY);
	return 0;
}

SEC("uretprobe.multi")
int BPF_KRETPROBE(handle_gai_ret, int rc)
{
	u32 tid = (u32)bpf_get_current_pid_tgid();
	struct start *s = bpf_map_lookup_elem(&start, &tid);
	struct task_struct *t;
	struct proc_key pk = {};
	struct proc_val *pv;
	struct name_key nk = {};
	struct name_val *nv;
	u64 delta, *cnt;
	u32 slot;

	if (!s)
		return 0;
	delta = bpf_ktime_get_ns() - s->ts;
	slot = log2_u64(delta / 1000);
	if (slot >= MAX_SLOTS)
		slot = MAX_SLOTS - 1;
	cnt = bpf_map_lookup_elem(&hist, &slot);
	if (cnt)
		*cnt += 1;

	__builtin_memcpy(nk.name, s->name, sizeof(nk.name));
	nv = bpf_map_lookup_elem(&names, &nk);
	if (!nv) {
		bpf_map_update_elem(&names, &nk, &nzero, BPF_NOEXIST);
		nv = bpf_map_lookup_elem(&names, &nk);
	}
	if (nv) {
		__sync_fetch_and_add(&nv->lookups, 1);
		__sync_fetch_and_add(&nv->lat_ns, delta);
		if (delta > nv->lat_max_ns)
			nv->lat_max_ns = delta;
		if (rc != 0) {
			__sync_fetch_and_add(&nv->fails, 1);
			nv->last_err = rc;
		}
	}

	t = (struct task_struct *)bpf_get_current_task_btf();
	pk.tgid = t->tgid;
	bpf_probe_read_kernel_str(pk.comm, sizeof(pk.comm), t->group_leader->comm);
	pv = bpf_map_lookup_elem(&procs, &pk);
	if (!pv) {
		bpf_map_update_elem(&procs, &pk, &pzero, BPF_NOEXIST);
		pv = bpf_map_lookup_elem(&procs, &pk);
	}
	if (pv) {
		__sync_fetch_and_add(&pv->lookups, 1);
		__sync_fetch_and_add(&pv->lat_ns, delta);
		if (delta > pv->lat_max_ns)
			pv->lat_max_ns = delta;
		if (rc != 0)
			__sync_fetch_and_add(&pv->fails, 1);
		// The verifier loses track of slot's range across the calls in between; re-check right before use
		barrier_var(slot);
		if (slot < MAX_SLOTS)
			__sync_fetch_and_add(&pv->slots[slot], 1);
	}
	bpf_map_delete_elem(&start, &tid);
	return 0;
}
