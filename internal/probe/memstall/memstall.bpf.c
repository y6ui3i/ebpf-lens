//go:build ignore

// memstall: メモリが足りないとき、プロセスが自分で空きを作る(回収する)ために止まった時間を測る。
// 全体の回収(direct reclaim)と cgroup の上限による回収(memcg reclaim)の begin/end の間を、
// スレッド単位で測ってプロセス別に積む。BCC の drsnoop を集計型にしたもの。

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#define MAX_SLOTS 27
#define TASK_COMM_LEN 16

char LICENSE[] SEC("license") = "Dual BSD/GPL";

struct proc_key {
	u32 tgid;
	char comm[TASK_COMM_LEN]; // スレッド名ではなくプロセス(group leader)の名前
};

struct proc_val {
	u64 count;
	u64 total_ns;
	u64 max_ns;
	u64 reclaimed;   // 回収できたページ数
	u64 memcg_count; // うち cgroup の上限による回収
	u64 slots[MAX_SLOTS]; // 停止時間の log2 ヒストグラム(µs)
};

// スレッド ID -> 回収を始めた時刻(ns)。begin と end は同じスレッドの中で起きる
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 10240);
	__type(key, u32);
	__type(value, u64);
} start SEC(".maps");

// プロセスごとの集計。ユーザー空間が区間ごとに読んで消す
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 4096);
	__type(key, struct proc_key);
	__type(value, struct proc_val);
} procs SEC(".maps");

// 停止時間のヒストグラム(ホスト全体)
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
	if (!tsp) // アタッチ前に始まった回収
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
		if (!v) // 満杯なら諦める(次の区間でユーザー空間が空にする)
			return;
	}
	__sync_fetch_and_add(&v->count, 1);
	__sync_fetch_and_add(&v->total_ns, delta);
	__sync_fetch_and_add(&v->reclaimed, nr_reclaimed);
	if (memcg)
		__sync_fetch_and_add(&v->memcg_count, 1);
	if (delta > v->max_ns) // 競合で取りこぼしうるが最大値の目安には十分
		v->max_ns = delta;
	// 途中の関数呼び出しで verifier が slot の範囲を見失うので、使う直前に確かめ直す。
	// コンパイラは上の clamp から「不要な比較」として消してしまうので、barrier_var で残させる
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
