//go:build ignore

// runqlat: accumulates the wait time from when a task wakes up (becomes runnable) until it
// actually gets on a CPU into a log2 histogram (microseconds). A simplified version of runqlat from libbpf-tools.
// It also accumulates "time spent on CPU" and "time spent waiting" per process (tgid),
// so we can show both the cause (who was using the CPU) and the impact (who was kept waiting).

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

#define MAX_SLOTS 27
#define TASK_RUNNING 0
#define TASK_COMM_LEN 16

char LICENSE[] SEC("license") = "Dual BSD/GPL";

struct proc_key {
	u32 tgid;
	char comm[TASK_COMM_LEN]; // name of the process (group leader), not the thread
};

struct proc_val {
	u64 oncpu_ns;
	u64 wait_count;
	u64 wait_ns;
	u64 wait_max_ns;
	u64 slots[MAX_SLOTS]; // log2 histogram of wait time (µs)
};

// Per-process aggregates. User space reads and deletes them every interval
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 8192);
	__type(key, struct proc_key);
	__type(value, struct proc_val);
} procs SEC(".maps");

// Per-CPU time of the last switch. It is the starting point of the time prev spent on the CPU
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 1);
	__type(key, u32);
	__type(value, u64);
} cpu_last SEC(".maps");

// pid -> wakeup time (ns)
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 10240);
	__type(key, u32);
	__type(value, u64);
} start SEC(".maps");

// slot -> count. Per-CPU, so the kernel side needs no locking; user space sums them up
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

static __always_inline void trace_enqueue(u32 pid)
{
	u64 ts;

	if (!pid) // do not count the idle task
		return;
	ts = bpf_ktime_get_ns();
	bpf_map_update_elem(&start, &pid, &ts, BPF_ANY);
}

static __always_inline struct proc_val *proc_of(struct task_struct *t)
{
	struct proc_key k = {};
	struct proc_val zero = {};
	struct proc_val *v;

	k.tgid = t->tgid;
	bpf_probe_read_kernel_str(k.comm, sizeof(k.comm), t->group_leader->comm);
	v = bpf_map_lookup_elem(&procs, &k);
	if (v)
		return v;
	// If the map is full, give up (user space empties it at the next interval)
	bpf_map_update_elem(&procs, &k, &zero, BPF_NOEXIST);
	return bpf_map_lookup_elem(&procs, &k);
}

SEC("tp_btf/sched_wakeup")
int BPF_PROG(handle_sched_wakeup, struct task_struct *p)
{
	trace_enqueue(p->pid);
	return 0;
}

SEC("tp_btf/sched_wakeup_new")
int BPF_PROG(handle_sched_wakeup_new, struct task_struct *p)
{
	trace_enqueue(p->pid);
	return 0;
}

SEC("tp_btf/sched_switch")
int BPF_PROG(handle_sched_switch, bool preempt, struct task_struct *prev,
	     struct task_struct *next, unsigned int prev_state)
{
	u32 pid, slot, zero = 0;
	u64 *tsp, *cnt, *last;
	u64 now = bpf_ktime_get_ns();
	struct proc_val *v;
	s64 delta;

	// Cause: prev is the one that used this CPU from the previous switch until now
	last = bpf_map_lookup_elem(&cpu_last, &zero);
	if (last) {
		if (*last && prev->pid) {
			v = proc_of(prev);
			if (v)
				__sync_fetch_and_add(&v->oncpu_ns, now - *last);
		}
		*last = now;
	}

	// A preempted task goes back onto the run queue still runnable
	if (prev_state == TASK_RUNNING)
		trace_enqueue(prev->pid);

	pid = next->pid;
	tsp = bpf_map_lookup_elem(&start, &pid);
	if (!tsp)
		return 0;
	delta = (s64)(now - *tsp);
	bpf_map_delete_elem(&start, &pid);
	if (delta < 0)
		return 0;

	slot = log2_u64((u64)delta / 1000);
	if (slot >= MAX_SLOTS)
		slot = MAX_SLOTS - 1;
	cnt = bpf_map_lookup_elem(&hist, &slot);
	if (cnt)
		*cnt += 1;

	// Impact: how long next was kept waiting
	v = proc_of(next);
	if (v) {
		__sync_fetch_and_add(&v->wait_count, 1);
		__sync_fetch_and_add(&v->wait_ns, (u64)delta);
		if ((u64)delta > v->wait_max_ns) // may miss an update under contention, but good enough as an indication of the max
			v->wait_max_ns = (u64)delta;
		__sync_fetch_and_add(&v->slots[slot], 1);
	}
	return 0;
}
