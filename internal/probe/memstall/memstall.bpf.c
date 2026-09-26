//go:build ignore

// memstall: when memory runs short, measures how long processes stall to free memory themselves (reclaim).
// The time between begin/end of global reclaim (direct reclaim) and of reclaim due to a cgroup limit (memcg reclaim)
// is measured per thread and accumulated per process. An aggregating version of BCC's drsnoop.

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#define MAX_SLOTS 27
#define TASK_COMM_LEN 16

char LICENSE[] SEC("license") = "Dual BSD/GPL";

struct proc_key {
	u32 tgid;
	char comm[TASK_COMM_LEN]; // name of the process (group leader), not the thread
};

struct proc_val {
	u64 count;
	u64 total_ns;
	u64 max_ns;
	u64 reclaimed;   // number of pages reclaimed
	u64 memcg_count; // of which, reclaims due to a cgroup limit
	u64 slots[MAX_SLOTS]; // log2 histogram of stall time (µs)
};

// thread ID -> time reclaim started (ns). begin and end happen on the same thread
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 10240);
	__type(key, u32);
	__type(value, u64);
} start SEC(".maps");

// Per-process aggregates. User space reads and deletes them every interval
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 4096);
	__type(key, struct proc_key);
	__type(value, struct proc_val);
} procs SEC(".maps");

// Histogram of stall time (whole host)
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, MAX_SLOTS);
	__type(key, u32);
	__type(value, u64);
} hist SEC(".maps");

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

static __always_inline void on_begin(void)
{
	u32 tid = (u32)bpf_get_current_pid_tgid();
	u64 ts = bpf_ktime_get_ns();

	bpf_map_update_elem(&start, &tid, &ts, BPF_ANY);
}

static __always_inline void on_end(unsigned long nr_reclaimed, bool memcg)
{
	u32 tid = (u32)bpf_get_current_pid_tgid();
	struct task_struct *cur = (struct task_struct *)bpf_get_current_task_btf();
	struct proc_key k = {};
	struct proc_val zero = {};
	struct proc_val *v;
	u64 *tsp, *cnt, delta;
	u32 slot;

	tsp = bpf_map_lookup_elem(&start, &tid);
	if (!tsp) // reclaim that started before we attached
		return;
	delta = bpf_ktime_get_ns() - *tsp;
	bpf_map_delete_elem(&start, &tid);

	slot = log2_u64(delta / 1000);
	if (slot >= MAX_SLOTS)
		slot = MAX_SLOTS - 1;
	cnt = bpf_map_lookup_elem(&hist, &slot);
	if (cnt)
		*cnt += 1;

	k.tgid = bpf_get_current_pid_tgid() >> 32;
	bpf_probe_read_kernel_str(k.comm, sizeof(k.comm), BPF_CORE_READ(cur, group_leader, comm));
	v = bpf_map_lookup_elem(&procs, &k);
	if (!v) {
		bpf_map_update_elem(&procs, &k, &zero, BPF_NOEXIST);
		v = bpf_map_lookup_elem(&procs, &k);
		if (!v) // if the map is full, give up (user space empties it at the next interval)
			return;
	}
	__sync_fetch_and_add(&v->count, 1);
	__sync_fetch_and_add(&v->total_ns, delta);
	__sync_fetch_and_add(&v->reclaimed, nr_reclaimed);
	if (memcg)
		__sync_fetch_and_add(&v->memcg_count, 1);
	if (delta > v->max_ns) // may miss an update under contention, but good enough as an indication of the max
		v->max_ns = delta;
	// The verifier loses track of slot's range across the function calls in between, so check it again right before use.
	// The compiler would drop this as a redundant comparison given the clamp above, so barrier_var keeps it
	barrier_var(slot);
	if (slot >= MAX_SLOTS)
		return;
	__sync_fetch_and_add(&v->slots[slot], 1);
}

SEC("tp_btf/mm_vmscan_direct_reclaim_begin")
int BPF_PROG(handle_direct_begin, int order, gfp_t gfp_flags)
{
	on_begin();
	return 0;
}

SEC("tp_btf/mm_vmscan_direct_reclaim_end")
int BPF_PROG(handle_direct_end, unsigned long nr_reclaimed)
{
	on_end(nr_reclaimed, false);
	return 0;
}

SEC("tp_btf/mm_vmscan_memcg_reclaim_begin")
int BPF_PROG(handle_memcg_begin, int order, gfp_t gfp_flags)
{
	on_begin();
	return 0;
}

SEC("tp_btf/mm_vmscan_memcg_reclaim_end")
int BPF_PROG(handle_memcg_end, unsigned long nr_reclaimed)
{
	on_end(nr_reclaimed, true);
	return 0;
}
