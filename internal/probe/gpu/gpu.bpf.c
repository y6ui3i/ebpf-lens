//go:build ignore

// gpu: what each CUDA process does with the GPU, seen from uprobes on libcuda (the driver API every CUDA
// runtime, PyTorch, llama.cpp and the rest end up calling):
//   - kernel launches (cuLaunchKernel / cuGraphLaunch): the process is giving the GPU work
//   - copies (cuMemcpyHtoDAsync / DtoHAsync / Async): bytes moved, and the time spent inside the call — a copy
//     from pageable host memory blocks inside the call, so this is "waiting for a transfer"
//   - synchronize calls (cuStreamSynchronize / cuCtxSynchronize / cuEventSynchronize): time spent waiting for the GPU
// Per-process totals go into `procs`; the wait time of every copy and sync call also goes into a log2 histogram (µs).
// NVML (user space) supplies the GPU's own utilization and VRAM; this file is the eBPF half of "why is the GPU idle".

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
	u64 launches;
	u64 h2d_bytes;
	u64 d2h_bytes;
	u64 copy_ns;
	u64 copy_count;
	u64 sync_ns;
	u64 sync_count;
};

// A call in progress on one thread: when it started and, for copies, how many bytes and which direction
struct call_start {
	u64 ts;
	u64 bytes;
	u32 dir; // 0 unknown (cuMemcpyAsync), 1 host->device, 2 device->host
};

// Per-process aggregates. User space reads and deletes them every interval
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 4096);
	__type(key, struct proc_key);
	__type(value, struct proc_val);
} procs SEC(".maps");

// tid -> copy in progress, and tid -> sync in progress. Two maps: a copy may synchronize internally
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 10240);
	__type(key, u32);
	__type(value, struct call_start);
} copy_start SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 10240);
	__type(key, u32);
	__type(value, u64);
} sync_start SEC(".maps");

// slot -> count of copy and sync calls by how long they waited (µs). Per-CPU; user space sums
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

static __always_inline struct proc_val *proc_of(void)
{
	struct task_struct *t = (struct task_struct *)bpf_get_current_task_btf();
	struct proc_key k = {};
	struct proc_val zero = {};
	struct proc_val *v;

	k.tgid = t->tgid;
	bpf_probe_read_kernel_str(k.comm, sizeof(k.comm), t->group_leader->comm);
	v = bpf_map_lookup_elem(&procs, &k);
	if (v)
		return v;
	bpf_map_update_elem(&procs, &k, &zero, BPF_NOEXIST);
	return bpf_map_lookup_elem(&procs, &k);
}

static __always_inline void count_wait(u64 delta_ns)
{
	u32 slot = log2_u64(delta_ns / 1000);
	u64 *cnt;

	if (slot >= MAX_SLOTS)
		slot = MAX_SLOTS - 1;
	cnt = bpf_map_lookup_elem(&hist, &slot);
	if (cnt)
		*cnt += 1;
}

// --- launches ---

SEC("uprobe.multi")
int BPF_KPROBE(handle_launch)
{
	struct proc_val *v = proc_of();

	if (v)
		__sync_fetch_and_add(&v->launches, 1);
	return 0;
}

// --- copies: cuMemcpy{HtoD,DtoH}Async(dst, src, ByteCount, hStream) and cuMemcpyAsync(dst, src, ByteCount, hStream) ---

static __always_inline int copy_enter(u64 bytes, u32 dir)
{
	u32 tid = (u32)bpf_get_current_pid_tgid();
	struct call_start s = { .ts = bpf_ktime_get_ns(), .bytes = bytes, .dir = dir };

	bpf_map_update_elem(&copy_start, &tid, &s, BPF_ANY);
	return 0;
}

SEC("uprobe.multi")
int BPF_KPROBE(handle_copy_h2d, void *dst, void *src, u64 bytes)
{
	return copy_enter(bytes, 1);
}

SEC("uprobe.multi")
int BPF_KPROBE(handle_copy_d2h, void *dst, void *src, u64 bytes)
{
	return copy_enter(bytes, 2);
}

SEC("uprobe.multi")
int BPF_KPROBE(handle_copy_any, void *dst, void *src, u64 bytes)
{
	return copy_enter(bytes, 0);
}

SEC("uretprobe.multi")
int BPF_KRETPROBE(handle_copy_ret)
{
	u32 tid = (u32)bpf_get_current_pid_tgid();
	struct call_start *s = bpf_map_lookup_elem(&copy_start, &tid);
	struct proc_val *v;
	u64 delta;

	if (!s)
		return 0;
	delta = bpf_ktime_get_ns() - s->ts;
	v = proc_of();
	if (v) {
		__sync_fetch_and_add(&v->copy_ns, delta);
		__sync_fetch_and_add(&v->copy_count, 1);
		if (s->dir == 1)
			__sync_fetch_and_add(&v->h2d_bytes, s->bytes);
		else if (s->dir == 2)
			__sync_fetch_and_add(&v->d2h_bytes, s->bytes);
	}
	count_wait(delta);
	bpf_map_delete_elem(&copy_start, &tid);
	return 0;
}

// --- synchronize: waiting for the GPU to finish ---

SEC("uprobe.multi")
int BPF_KPROBE(handle_sync)
{
	u32 tid = (u32)bpf_get_current_pid_tgid();
	u64 ts = bpf_ktime_get_ns();

	bpf_map_update_elem(&sync_start, &tid, &ts, BPF_ANY);
	return 0;
}

SEC("uretprobe.multi")
int BPF_KRETPROBE(handle_sync_ret)
{
	u32 tid = (u32)bpf_get_current_pid_tgid();
	u64 *ts = bpf_map_lookup_elem(&sync_start, &tid);
	struct proc_val *v;
	u64 delta;

	if (!ts)
		return 0;
	delta = bpf_ktime_get_ns() - *ts;
	v = proc_of();
	if (v) {
		__sync_fetch_and_add(&v->sync_ns, delta);
		__sync_fetch_and_add(&v->sync_count, 1);
	}
	count_wait(delta);
	bpf_map_delete_elem(&sync_start, &tid);
	return 0;
}
