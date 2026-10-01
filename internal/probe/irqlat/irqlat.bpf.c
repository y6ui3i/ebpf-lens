//go:build ignore

// irqlat: time the CPUs spend in interrupt context, which no process is charged for and top does not show as
// anyone's.
//   - Soft interrupts (softirq_entry / softirq_exit): per CPU and per vector (NET_RX, NET_TX, TIMER, BLOCK, RCU,
//     SCHED...) how often and for how long, plus a histogram of one softirq's run time (a softirq that runs for
//     milliseconds delays everything on that CPU)
//   - Hard interrupts (irq_handler_entry / irq_handler_exit): per IRQ number and per CPU
// The verdict is per CPU: one CPU spending a third of its time in NET_RX is the network interrupt landing on one
// core — spread it (RSS, RPS, irqbalance) rather than buying a faster one.
//
// Everything here is a per-CPU array: no hash map, no spinlock, no string copy. These programs run in hardirq
// and softirq context; a locking map there adds bucket-lock contention in interrupt context, and every contended
// lock fires the kernel's lock contention tracepoints, which another probe (lockwait) listens to. The hard
// lockups of 2026-10-01 turned out to be lockwait's own recursion (docs/adr/0004), with this probe's first,
// hash-map version only raising the odds — but the rule stands: a program in interrupt context takes no lock.
// The interrupt path is plain per-CPU additions; the IRQ names come from /proc/interrupts in user space.

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#define MAX_SLOTS 27
#define NR_VECS 16
#define MAX_IRQS 512

char LICENSE[] SEC("license") = "Dual BSD/GPL";

struct count_ns {
	u64 count;
	u64 ns;
};

// softirq in progress on this CPU (softirqs do not nest with each other)
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 1);
	__type(key, u32);
	__type(value, u64);
} soft_start SEC(".maps");

// hardirq in progress on this CPU
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 1);
	__type(key, u32);
	__type(value, u64);
} irq_start SEC(".maps");

// softirq time per vector, per CPU (the per-CPU array gives the CPU dimension for free)
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, NR_VECS);
	__type(key, u32);
	__type(value, struct count_ns);
} soft SEC(".maps");

// hardirq time per irq number, per CPU
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, MAX_IRQS);
	__type(key, u32);
	__type(value, struct count_ns);
} irqs SEC(".maps");

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

SEC("tp_btf/softirq_entry")
int BPF_PROG(handle_softirq_entry, unsigned int vec)
{
	u32 zero = 0;
	u64 *ts = bpf_map_lookup_elem(&soft_start, &zero);

	if (ts)
		*ts = bpf_ktime_get_ns();
	return 0;
}

SEC("tp_btf/softirq_exit")
int BPF_PROG(handle_softirq_exit, unsigned int vec)
{
	u32 zero = 0;
	u64 *ts = bpf_map_lookup_elem(&soft_start, &zero);
	struct count_ns *v;
	u64 delta, *cnt;
	u32 slot;

	if (!ts || !*ts)
		return 0;
	delta = bpf_ktime_get_ns() - *ts;
	*ts = 0;
	if (vec >= NR_VECS)
		return 0;
	v = bpf_map_lookup_elem(&soft, &vec);
	if (v) {
		v->count += 1;
		v->ns += delta;
	}
	slot = log2_u64(delta / 1000);
	if (slot >= MAX_SLOTS)
		slot = MAX_SLOTS - 1;
	cnt = bpf_map_lookup_elem(&hist, &slot);
	if (cnt)
		*cnt += 1;
	return 0;
}

SEC("tp_btf/irq_handler_entry")
int BPF_PROG(handle_irq_entry, int irq, struct irqaction *action)
{
	u32 zero = 0;
	u64 *ts = bpf_map_lookup_elem(&irq_start, &zero);

	if (ts)
		*ts = bpf_ktime_get_ns();
	return 0;
}

SEC("tp_btf/irq_handler_exit")
int BPF_PROG(handle_irq_exit, int irq, struct irqaction *action, int ret)
{
	u32 zero = 0;
	u64 *ts = bpf_map_lookup_elem(&irq_start, &zero);
	struct count_ns *v;
	u64 delta;
	u32 key = irq;

	if (!ts || !*ts)
		return 0;
	delta = bpf_ktime_get_ns() - *ts;
	*ts = 0;
	if (key >= MAX_IRQS)
		key = MAX_IRQS - 1; // one bucket for the rare high numbers
	v = bpf_map_lookup_elem(&irqs, &key);
	if (v) {
		v->count += 1;
		v->ns += delta;
	}
	return 0;
}
