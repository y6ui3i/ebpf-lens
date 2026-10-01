//go:build ignore

// pgfault: page faults as the process feels them. fentry/fexit on handle_mm_fault (every user page fault ends
// there, and so do get_user_pages from the kernel) gives, per fault: how long it took, whether it was MAJOR (the
// page had to come from disk: a file read back into the page cache, or an anonymous page read back from swap),
// and from the VMA whether it was anonymous memory — a major fault on an anonymous VMA is a swap-in. Minor
// faults are counted; major ones are timed per process (count, total, max, histogram). A host that is
// thrashing shows here as the processes that spend their time waiting for their own memory to come back.

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#define MAX_SLOTS 27
#define TASK_COMM_LEN 16
#define VM_FAULT_MAJOR 0x4

char LICENSE[] SEC("license") = "Dual BSD/GPL";

struct proc_key {
	u32 tgid;
	char comm[TASK_COMM_LEN];
};

struct proc_val {
	u64 minor;
	u64 major;
	u64 swapin; // major faults on anonymous memory: pages read back from swap
	u64 major_ns;
	u64 major_max_ns;
	u64 slots[MAX_SLOTS];
};

struct start {
	u64 ts;
	u8 anon;
	u8 pad[7];
};

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 16384);
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
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, MAX_SLOTS);
	__type(key, u32);
	__type(value, u64);
} hist SEC(".maps");

static const struct proc_val pzero;

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

// vm_fault_t handle_mm_fault(struct vm_area_struct *vma, unsigned long address, unsigned int flags, struct pt_regs *regs)
SEC("fentry/handle_mm_fault")
int BPF_PROG(handle_fault, struct vm_area_struct *vma, unsigned long address, unsigned int flags, struct pt_regs *regs)
{
	u32 tid = (u32)bpf_get_current_pid_tgid();
	struct start s = {};

	s.ts = bpf_ktime_get_ns();
	s.anon = BPF_CORE_READ(vma, vm_file) == NULL;
	bpf_map_update_elem(&start, &tid, &s, BPF_ANY);
	return 0;
}

SEC("fexit/handle_mm_fault")
int BPF_PROG(handle_fault_ret, struct vm_area_struct *vma, unsigned long address, unsigned int flags, struct pt_regs *regs, unsigned int ret)
{
	u32 tid = (u32)bpf_get_current_pid_tgid();
	struct start *s = bpf_map_lookup_elem(&start, &tid);
	struct task_struct *t;
	struct proc_key pk = {};
	struct proc_val *pv;
	u64 delta, *cnt;
	u32 slot;
	u8 anon;

	if (!s)
		return 0;
	delta = bpf_ktime_get_ns() - s->ts;
	anon = s->anon;
	bpf_map_delete_elem(&start, &tid);

	t = (struct task_struct *)bpf_get_current_task_btf();
	pk.tgid = t->tgid;
	bpf_probe_read_kernel_str(pk.comm, sizeof(pk.comm), t->group_leader->comm);
	pv = bpf_map_lookup_elem(&procs, &pk);
	if (!pv) {
		bpf_map_update_elem(&procs, &pk, &pzero, BPF_NOEXIST);
		pv = bpf_map_lookup_elem(&procs, &pk);
	}
	if (!pv)
		return 0;
	if (!(ret & VM_FAULT_MAJOR)) {
		__sync_fetch_and_add(&pv->minor, 1);
		return 0;
	}
	__sync_fetch_and_add(&pv->major, 1);
	if (anon)
		__sync_fetch_and_add(&pv->swapin, 1);
	__sync_fetch_and_add(&pv->major_ns, delta);
	if (delta > pv->major_max_ns)
		pv->major_max_ns = delta;
	slot = log2_u64(delta / 1000);
	if (slot >= MAX_SLOTS)
		slot = MAX_SLOTS - 1;
	cnt = bpf_map_lookup_elem(&hist, &slot);
	if (cnt)
		*cnt += 1;
	barrier_var(slot);
	if (slot < MAX_SLOTS)
		__sync_fetch_and_add(&pv->slots[slot], 1);
	return 0;
}
