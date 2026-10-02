//go:build ignore

// lockwait: time spent waiting for a lock — the wait that is neither CPU nor I/O, the one every other screen
// calls "waiting for something else".
//   - User-space locks, through the futex syscall. A pthread mutex that is contended, Python's GIL mutex, Go's
//     runtime locks all end in FUTEX_WAIT on the lock's address. So does parking an idle thread (Go's scheduler,
//     thread pools), which is not contention at all. The two are told apart by the address: a contended lock is
//     waited on by two or more threads, a parked thread waits on its own address alone. Per (process, address)
//     the waits, the time and whether more than one thread waited; user space keeps only the contended ones
//     (measured: 8 threads on one mutex → 70 s of waiting on 1 address; idle Go services → 80 s on 13
//     addresses, every one of them single-waiter)
//   - Kernel locks, through the lock:contention_begin / contention_end tracepoints (5.19+): mutexes, rwsems
//     (mmap_lock under a multi-threaded process, inode locks on a hot file), spinlocks, per kind and per process

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#define MAX_SLOTS 27
#define TASK_COMM_LEN 16
#define NR_FUTEX 202
#define FUTEX_CMD_MASK 127
#define FUTEX_WAIT 0
#define FUTEX_LOCK_PI 6
#define MAX_KINDS 8

// LCB_F_* flags of the contention tracepoints
#define LCB_F_SPIN 1
#define LCB_F_READ 2
#define LCB_F_WRITE 4
#define LCB_F_RT 8
#define LCB_F_PERCPU 16
#define LCB_F_MUTEX 32

char LICENSE[] SEC("license") = "Dual BSD/GPL";

// One futex address in one process
struct ulock_key {
	u32 tgid;
	u32 pad;
	u64 uaddr;
};

struct ulock_val {
	u64 waits;
	u64 ns;
	u64 max_ns;
	u32 last_tid;
	u32 waiters; // 1, or 2 once a second thread has waited on it (then it is a lock, not a parked thread)
	char comm[TASK_COMM_LEN];
	u64 slots[MAX_SLOTS];
};

struct ustart {
	u64 ts;
	u64 uaddr;
};

struct proc_key {
	u32 tgid;
	char comm[TASK_COMM_LEN];
};

// Kernel lock waits per process
struct kproc_val {
	u64 waits;
	u64 ns;
	u64 max_ns;
};

struct kstart {
	u64 ts;
	u32 flags;
	u32 pad;
};

// A spinlock wait in progress on this CPU. On the spinlock path this program must not touch a locking map
// (hash, LRU): a map's bucket lock is itself a spinlock (BPF's rqspinlock), and when it is contended it fires
// the very tracepoints this program is attached to, from inside its slow path. The first version deleted its
// start-time entry from an LRU hash here; the bucket lock fired contention_end for itself, a second copy of this
// program (two agents on one host) ran nested and went for a bucket lock of its own map while the CPU held
// jiffies_lock, rqspinlock stalled on the deadlock it had detected (a kernel bug, fixed upstream in
// 7a3c0289c3c8), and the whole machine hard-locked (2026-10-01, four times; backtrace in docs/adr/0004). A spinner does not sleep or
// migrate, so a per-CPU slot is enough, and perf's lock_contention.bpf.c does the same. Sleeping locks (mutex,
// rwsem) are process context and keep the per-thread map: the nested events their map operations cause are
// spinlock events and take this path
struct spin_start {
	u64 ts;
	u64 lock;
};

struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 1);
	__type(key, u32);
	__type(value, struct spin_start);
} spin SEC(".maps");

struct kind_val {
	u64 waits;
	u64 ns;
	u64 max_ns;
};

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 16384);
	__type(key, u32); // tid
	__type(value, struct ustart);
} ustart SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 16384);
	__type(key, struct ulock_key);
	__type(value, struct ulock_val);
} ulocks SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 16384);
	__type(key, u32); // tid
	__type(value, struct kstart);
} kstart SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 4096);
	__type(key, struct proc_key);
	__type(value, struct kproc_val);
} kprocs SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, MAX_KINDS);
	__type(key, u32);
	__type(value, struct kind_val);
} kinds SEC(".maps");

static const struct ulock_val uzero;
static const struct kproc_val kzero;

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

// --- user-space locks (futex) ---

SEC("tp_btf/sys_enter")
int BPF_PROG(handle_sys_enter, struct pt_regs *regs, long id)
{
	u32 tid = (u32)bpf_get_current_pid_tgid();
	struct ustart s;
	u32 op;

	if (id != NR_FUTEX)
		return 0;
	op = PT_REGS_PARM2_CORE_SYSCALL(regs) & FUTEX_CMD_MASK;
	if (op != FUTEX_WAIT && op != FUTEX_LOCK_PI)
		return 0; // FUTEX_WAIT_BITSET is what condition variables use: waiting for work, not for a lock
	s.ts = bpf_ktime_get_ns();
	s.uaddr = PT_REGS_PARM1_CORE_SYSCALL(regs);
	bpf_map_update_elem(&ustart, &tid, &s, BPF_ANY);
	return 0;
}

SEC("tp_btf/sys_exit")
int BPF_PROG(handle_sys_exit, struct pt_regs *regs, long ret)
{
	u64 pid_tgid = bpf_get_current_pid_tgid();
	u32 tid = (u32)pid_tgid;
	struct ustart *s;
	struct ulock_key k = {};
	struct ulock_val *v;
	u64 delta;
	u32 slot;

	if (BPF_CORE_READ(regs, orig_ax) != NR_FUTEX)
		return 0;
	s = bpf_map_lookup_elem(&ustart, &tid);
	if (!s)
		return 0;
	delta = bpf_ktime_get_ns() - s->ts;
	// A thread parked for half a minute that happens to share its address with one other waiter would count as
	// half a minute of contention when it wakes; a contended lock wait is milliseconds. One wait counts for at
	// most a second (seen once on the test host: containerd-shim, 30 s in one second, before this cap)
	if (delta > 1000000000ULL)
		delta = 1000000000ULL;
	k.tgid = pid_tgid >> 32;
	k.uaddr = s->uaddr;
	bpf_map_delete_elem(&ustart, &tid);
	v = bpf_map_lookup_elem(&ulocks, &k);
	if (!v) {
		bpf_map_update_elem(&ulocks, &k, &uzero, BPF_NOEXIST);
		v = bpf_map_lookup_elem(&ulocks, &k);
		if (!v)
			return 0;
		struct task_struct *t = (struct task_struct *)bpf_get_current_task_btf();

		bpf_probe_read_kernel_str(v->comm, sizeof(v->comm), t->group_leader->comm);
		v->last_tid = tid;
		v->waiters = 1;
	} else if (v->last_tid != tid) {
		v->waiters = 2;
	}
	__sync_fetch_and_add(&v->waits, 1);
	__sync_fetch_and_add(&v->ns, delta);
	if (delta > v->max_ns)
		v->max_ns = delta;
	slot = log2_u64(delta / 1000);
	if (slot >= MAX_SLOTS)
		slot = MAX_SLOTS - 1;
	barrier_var(slot);
	if (slot < MAX_SLOTS)
		__sync_fetch_and_add(&v->slots[slot], 1);
	return 0;
}

// --- kernel locks ---

// Kind index, must match kindNames on the Go side
static __always_inline u32 kind_of(u32 flags)
{
	if (flags & LCB_F_MUTEX)
		return 0;
	if (flags & LCB_F_RT)
		return 4;
	if (flags & LCB_F_PERCPU)
		return 5;
	if (flags & LCB_F_SPIN)
		return 3;
	if (flags & LCB_F_READ)
		return 1;
	if (flags & LCB_F_WRITE)
		return 2;
	return 6;
}

SEC("tp_btf/contention_begin")
int BPF_PROG(handle_contention_begin, void *lock, unsigned int flags)
{
	u32 tid = (u32)bpf_get_current_pid_tgid();
	struct kstart s = {};

	if (flags & LCB_F_SPIN) {
		u32 zero = 0;
		struct spin_start *sp = bpf_map_lookup_elem(&spin, &zero);

		if (sp) {
			sp->ts = bpf_ktime_get_ns();
			sp->lock = (u64)lock;
		}
		return 0;
	}
	s.ts = bpf_ktime_get_ns();
	s.flags = flags;
	bpf_map_update_elem(&kstart, &tid, &s, BPF_ANY);
	return 0;
}

SEC("tp_btf/contention_end")
int BPF_PROG(handle_contention_end, void *lock, int ret)
{
	u32 tid = (u32)bpf_get_current_pid_tgid();
	u32 zero = 0;
	struct spin_start *sp = bpf_map_lookup_elem(&spin, &zero);
	struct kstart *s;
	struct task_struct *t;
	struct proc_key pk = {};
	struct kproc_val *pv;
	struct kind_val *kv;
	u64 delta;
	u32 kind;

	// A spinlock wait ending on this CPU: per-CPU totals only, no per-process row (this may be interrupt
	// context, where "current" is whoever was interrupted)
	if (sp && sp->ts && sp->lock == (u64)lock) {
		delta = bpf_ktime_get_ns() - sp->ts;
		sp->ts = 0;
		kind = 3;
		kv = bpf_map_lookup_elem(&kinds, &kind);
		if (kv) {
			kv->waits += 1;
			kv->ns += delta;
			if (delta > kv->max_ns)
				kv->max_ns = delta;
		}
		return 0;
	}
	s = bpf_map_lookup_elem(&kstart, &tid);
	if (!s)
		return 0;
	delta = bpf_ktime_get_ns() - s->ts;
	// Same cap as for user-space locks: a driver thread that sleeps on a mutex for two minutes waiting for an
	// event is not two minutes of contention (seen on the test host: nvidia-drm/time, 130 s in 6 waits)
	if (delta > 1000000000ULL)
		delta = 1000000000ULL;
	kind = kind_of(s->flags);
	bpf_map_delete_elem(&kstart, &tid);
	kv = bpf_map_lookup_elem(&kinds, &kind);
	if (kv) {
		kv->waits += 1;
		kv->ns += delta;
		if (delta > kv->max_ns)
			kv->max_ns = delta;
	}
	t = (struct task_struct *)bpf_get_current_task_btf();
	pk.tgid = t->tgid;
	bpf_probe_read_kernel_str(pk.comm, sizeof(pk.comm), t->group_leader->comm);
	pv = bpf_map_lookup_elem(&kprocs, &pk);
	if (!pv) {
		bpf_map_update_elem(&kprocs, &pk, &kzero, BPF_NOEXIST);
		pv = bpf_map_lookup_elem(&kprocs, &pk);
	}
	if (pv) {
		__sync_fetch_and_add(&pv->waits, 1);
		__sync_fetch_and_add(&pv->ns, delta);
		if (delta > pv->max_ns)
			pv->max_ns = delta;
	}
	return 0;
}
