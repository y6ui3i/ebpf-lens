//go:build ignore

// runqlat: タスクが起床(runnable)してから実際に CPU に載るまでの待ち時間を
// log2 ヒストグラム(マイクロ秒)に積む。libbpf-tools の runqlat を簡略化したもの。

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

#define MAX_SLOTS 27
#define TASK_RUNNING 0

char LICENSE[] SEC("license") = "Dual BSD/GPL";

// pid -> 起床時刻(ns)
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 10240);
	__type(key, u32);
	__type(value, u64);
} start SEC(".maps");

// slot -> 件数。per-CPU なのでカーネル側はロック不要、ユーザー空間で合算する
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

	if (!pid) // idle タスクは数えない
		return;
	ts = bpf_ktime_get_ns();
	bpf_map_update_elem(&start, &pid, &ts, BPF_ANY);
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
	u32 pid, slot;
	u64 *tsp, *cnt;
	s64 delta;

	// 横取り(preempt)されたタスクは runnable のまま待ち行列に戻る
	if (prev_state == TASK_RUNNING)
		trace_enqueue(prev->pid);

	pid = next->pid;
	tsp = bpf_map_lookup_elem(&start, &pid);
	if (!tsp)
		return 0;
	delta = (s64)(bpf_ktime_get_ns() - *tsp);
	bpf_map_delete_elem(&start, &pid);
	if (delta < 0)
		return 0;

	slot = log2_u64((u64)delta / 1000);
	if (slot >= MAX_SLOTS)
		slot = MAX_SLOTS - 1;
	cnt = bpf_map_lookup_elem(&hist, &slot);
	if (cnt)
		*cnt += 1;
	return 0;
}
