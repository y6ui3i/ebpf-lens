//go:build ignore

// runqlat: タスクが起床(runnable)してから実際に CPU に載るまでの待ち時間を
// log2 ヒストグラム(マイクロ秒)に積む。libbpf-tools の runqlat を簡略化したもの。
// あわせてプロセス(tgid)ごとに「CPU を使った時間」と「待たされた時間」を積み、
// 原因(誰が CPU を使っていたか)と影響(誰が待たされたか)を出せるようにする。

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

#define MAX_SLOTS 27
#define TASK_RUNNING 0
#define TASK_COMM_LEN 16

char LICENSE[] SEC("license") = "Dual BSD/GPL";

struct proc_key {
	u32 tgid;
	char comm[TASK_COMM_LEN]; // スレッド名ではなくプロセス(group leader)の名前
};

struct proc_val {
	u64 oncpu_ns;
	u64 wait_count;
	u64 wait_ns;
	u64 wait_max_ns;
	u64 slots[MAX_SLOTS]; // 待ち時間の log2 ヒストグラム(µs)
};

// プロセスごとの集計。ユーザー空間が区間ごとに読んで消す
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 8192);
	__type(key, struct proc_key);
	__type(value, struct proc_val);
} procs SEC(".maps");

// CPU ごとの直前の切り替え時刻。prev が CPU を使っていた時間の起点になる
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 1);
	__type(key, u32);
	__type(value, u64);
} cpu_last SEC(".maps");

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
	// 満杯なら諦める(次の区間でユーザー空間が空にする)
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

	// 原因: 前回の切り替えから今までこの CPU を使っていたのは prev
	last = bpf_map_lookup_elem(&cpu_last, &zero);
	if (last) {
		if (*last && prev->pid) {
			v = proc_of(prev);
			if (v)
				__sync_fetch_and_add(&v->oncpu_ns, now - *last);
		}
		*last = now;
	}

	// 横取り(preempt)されたタスクは runnable のまま待ち行列に戻る
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

	// 影響: next がどれだけ待たされたか
	v = proc_of(next);
	if (v) {
		__sync_fetch_and_add(&v->wait_count, 1);
		__sync_fetch_and_add(&v->wait_ns, (u64)delta);
		if ((u64)delta > v->wait_max_ns) // 競合で取りこぼしうるが最大値の目安には十分
			v->wait_max_ns = (u64)delta;
		__sync_fetch_and_add(&v->slots[slot], 1);
	}
	return 0;
}
