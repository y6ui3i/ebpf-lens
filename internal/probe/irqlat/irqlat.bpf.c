//go:build ignore

// irqlat: time the CPUs spend in interrupt context, which no process is charged for and top does not show as
// anyone's.
//   - Soft interrupts (softirq_entry / softirq_exit): per CPU and per vector (NET_RX, NET_TX, TIMER, BLOCK, RCU,
//     SCHED...) how often and for how long, plus a histogram of one softirq's run time (a softirq that runs for
//     milliseconds delays everything on that CPU)
//   - Hard interrupts (irq_handler_entry / irq_handler_exit): per IRQ, by the handler's name (the NIC, the NVMe),
//     and per CPU
// The verdict is per CPU: one CPU spending a third of its time in NET_RX is the network interrupt landing on one
// core — spread it (RSS, RPS, irqbalance) rather than buying a faster one.

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#define MAX_SLOTS 27
#define MAX_CPUS 1024
#define NR_VECS 16
#define IRQ_NAME_LEN 16

char LICENSE[] SEC("license") = "Dual BSD/GPL";

struct count_ns {
	u64 count;
	u64 ns;
};

struct irq_val {
	u64 count;
	u64 ns;
	char name[IRQ_NAME_LEN];
};

struct irq_start {
	u64 ts;
	u64 action; // struct irqaction *, kept as a number so bpf2go can mirror the struct
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
	__type(value, struct irq_start);
} irq_start SEC(".maps");

// softirq time per (cpu, vec): key = cpu * NR_VECS + vec
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, MAX_CPUS * NR_VECS);
	__type(key, u32);
	__type(value, struct count_ns);
} soft SEC(".maps");

// hardirq time per irq number
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 4096);
	__type(key, u32);
	__type(value, struct irq_val);
} irqs SEC(".maps");

// hardirq time per cpu
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 1);
	__type(key, u32);
	__type(value, struct count_ns);
} irq_cpu SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, MAX_SLOTS);
	__type(key, u32);
	__type(value, u64);
} hist SEC(".maps");

static const struct count_ns czero;
static const struct irq_val izero;

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
	u32 key, slot;

	if (!ts || !*ts)
		return 0;
	delta = bpf_ktime_get_ns() - *ts;
	*ts = 0;
	if (vec >= NR_VECS)
		return 0;
	key = bpf_get_smp_processor_id() * NR_VECS + vec;
	v = bpf_map_lookup_elem(&soft, &key);
	if (!v) {
		bpf_map_update_elem(&soft, &key, &czero, BPF_NOEXIST);
		v = bpf_map_lookup_elem(&soft, &key);
	}
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
	struct irq_start *s = bpf_map_lookup_elem(&irq_start, &zero);

	if (s) {
		s->ts = bpf_ktime_get_ns();
		s->action = (u64)action;
	}
	return 0;
}

SEC("tp_btf/irq_handler_exit")
int BPF_PROG(handle_irq_exit, int irq, struct irqaction *action, int ret)
{
	u32 zero = 0;
	struct irq_start *s = bpf_map_lookup_elem(&irq_start, &zero);
	struct irq_val *v;
	struct count_ns *c;
	u64 delta;
	u32 key = irq;

	if (!s || !s->ts)
		return 0;
	delta = bpf_ktime_get_ns() - s->ts;
	s->ts = 0;
	v = bpf_map_lookup_elem(&irqs, &key);
	if (!v) {
		bpf_map_update_elem(&irqs, &key, &izero, BPF_NOEXIST);
		v = bpf_map_lookup_elem(&irqs, &key);
		if (v) {
			const char *name = BPF_CORE_READ(action, name);

			bpf_probe_read_kernel_str(v->name, sizeof(v->name), name);
		}
	}
	if (v) {
		v->count += 1;
		v->ns += delta;
	}
	c = bpf_map_lookup_elem(&irq_cpu, &zero);
	if (c) {
		c->count += 1;
		c->ns += delta;
	}
	return 0;
}
