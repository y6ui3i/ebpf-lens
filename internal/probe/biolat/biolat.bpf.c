//go:build ignore

// biolat: block I/O latency from the moment a request is issued to the device until it completes
// (block_rq_issue -> block_rq_complete), as a log2 histogram (µs), plus per-device and per-process totals.
// A simplified version of biolatency from libbpf-tools, with two additions:
//   - per device: I/Os, bytes, latency and errors (blk_status != OK), so "which disk" and "did anything fail"
//   - per process: the task that submitted the I/O (captured at block_bio_queue, in the submitter's context; the
//     later block_rq_issue often runs in a dispatch worker). Reads and direct writes are submitted by the process
//     itself; buffered writes are submitted later by a kernel writeback thread (kworker), and are filed under it

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#define MAX_SLOTS 27
#define TASK_COMM_LEN 16
#define DISK_NAME_LEN 32
#define REQ_OP_MASK 0xff // low 8 bits of cmd_flags (REQ_OP_BITS)
#define REQ_OP_WRITE 1

char LICENSE[] SEC("license") = "Dual BSD/GPL";

struct proc_key {
	u32 tgid;
	char comm[TASK_COMM_LEN];
};

struct proc_val {
	u64 reads;
	u64 writes;
	u64 read_bytes;
	u64 write_bytes;
	u64 lat_ns;
	u64 lat_max_ns;
	u64 slots[MAX_SLOTS];
};

struct dev_key {
	char name[DISK_NAME_LEN];
};

struct dev_val {
	u64 reads;
	u64 writes;
	u64 read_bytes;
	u64 write_bytes;
	u64 errors;
	u64 lat_ns;
	u64 lat_max_ns;
	u64 slots[MAX_SLOTS];
};

// A request in flight: when it was issued, by whom, and how big it is
struct start {
	u64 ts;
	u64 bytes;
	u32 tgid;
	char comm[TASK_COMM_LEN];
};

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 10240);
	__type(key, u64); // struct request *
	__type(value, struct start);
} start SEC(".maps");

// Who submitted a bio. block_rq_issue often runs in a dispatch worker (kworker) rather than in the process that
// submitted the I/O, so the owner is captured at block_bio_queue, which is still in the submitter's context
struct owner {
	u32 tgid;
	char comm[TASK_COMM_LEN];
};

// LRU: a bio that is merged into another request is never looked up here, and its entry would otherwise
// outlive it and be handed to whatever bio is later allocated at the same address
struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 16384);
	__type(key, u64); // struct bio *
	__type(value, struct owner);
} bio_owner SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 4096);
	__type(key, struct proc_key);
	__type(value, struct proc_val);
} procs SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 256);
	__type(key, struct dev_key);
	__type(value, struct dev_val);
} devs SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, MAX_SLOTS);
	__type(key, u32);
	__type(value, u64);
} hist SEC(".maps");

// Zero values for new map entries live in .rodata: an aggregate with a 27-slot histogram does not fit the 512-byte
// BPF stack twice over
static const struct proc_val pzero;
static const struct dev_val dzero;

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

static __always_inline void remember_owner(struct bio *bio)
{
	struct task_struct *t = (struct task_struct *)bpf_get_current_task_btf();
	struct owner o = {};
	u64 key = (u64)bio;

	o.tgid = t->tgid;
	bpf_probe_read_kernel_str(o.comm, sizeof(o.comm), t->group_leader->comm);
	bpf_map_update_elem(&bio_owner, &key, &o, BPF_ANY);
}

SEC("tp_btf/block_bio_queue")
int BPF_PROG(handle_bio_queue, struct bio *bio)
{
	remember_owner(bio);
	return 0;
}

// A bio larger than the device's limit is split; the first part is a new bio that never passes block_bio_queue,
// and it becomes the request's first bio. Still the submitter's context, so record it too
SEC("tp_btf/block_split")
int BPF_PROG(handle_split, struct bio *split, unsigned int new_sector)
{
	remember_owner(split);
	return 0;
}

// Every bio ends here (merged ones included), so the owner entry goes away with it
SEC("tp_btf/block_bio_complete")
int BPF_PROG(handle_bio_complete, struct request_queue *q, struct bio *bio)
{
	u64 key = (u64)bio;

	bpf_map_delete_elem(&bio_owner, &key);
	return 0;
}

SEC("tp_btf/block_rq_issue")
int BPF_PROG(handle_rq_issue, struct request *rq)
{
	struct start s = {};
	u64 key = (u64)rq;
	u64 bkey = (u64)BPF_CORE_READ(rq, bio);
	struct owner *o = bpf_map_lookup_elem(&bio_owner, &bkey);

	s.ts = bpf_ktime_get_ns();
	s.bytes = BPF_CORE_READ(rq, __data_len);
	if (o) {
		// The request's first bio names the submitter (merged bios from other tasks are filed under it too)
		s.tgid = o->tgid;
		__builtin_memcpy(s.comm, o->comm, sizeof(s.comm));
	} else {
		struct task_struct *t = (struct task_struct *)bpf_get_current_task_btf();

		s.tgid = t->tgid;
		bpf_probe_read_kernel_str(s.comm, sizeof(s.comm), t->group_leader->comm);
	}
	bpf_map_update_elem(&start, &key, &s, BPF_ANY);
	return 0;
}

SEC("tp_btf/block_rq_complete")
int BPF_PROG(handle_rq_complete, struct request *rq, blk_status_t error, unsigned int nr_bytes)
{
	u64 key = (u64)rq;
	struct start *s = bpf_map_lookup_elem(&start, &key);
	struct proc_key pk = {};
	struct proc_val *pv;
	struct dev_key dk = {};
	struct dev_val *dv;
	u64 now, delta, *cnt;
	u32 slot, zero = 0;
	int write;

	if (!s)
		return 0;
	now = bpf_ktime_get_ns();
	delta = now - s->ts;
	slot = log2_u64(delta / 1000);
	if (slot >= MAX_SLOTS)
		slot = MAX_SLOTS - 1;
	write = (BPF_CORE_READ(rq, cmd_flags) & REQ_OP_MASK) == REQ_OP_WRITE;

	cnt = bpf_map_lookup_elem(&hist, &slot);
	if (cnt)
		*cnt += 1;

	// Which disk: the gendisk behind the request queue
	BPF_CORE_READ_STR_INTO(&dk.name, rq, q, disk, disk_name);
	dv = bpf_map_lookup_elem(&devs, &dk);
	if (!dv) {
		bpf_map_update_elem(&devs, &dk, &dzero, BPF_NOEXIST);
		dv = bpf_map_lookup_elem(&devs, &dk);
	}
	if (dv) {
		if (write) {
			__sync_fetch_and_add(&dv->writes, 1);
			__sync_fetch_and_add(&dv->write_bytes, s->bytes);
		} else {
			__sync_fetch_and_add(&dv->reads, 1);
			__sync_fetch_and_add(&dv->read_bytes, s->bytes);
		}
		if (error)
			__sync_fetch_and_add(&dv->errors, 1);
		__sync_fetch_and_add(&dv->lat_ns, delta);
		if (delta > dv->lat_max_ns)
			dv->lat_max_ns = delta;
		// The verifier loses track of slot's range across the calls in between, so check it again right before
		// use; barrier_var stops the compiler from dropping the "redundant" comparison
		barrier_var(slot);
		if (slot < MAX_SLOTS)
			__sync_fetch_and_add(&dv->slots[slot], 1);
	}

	// Who issued it
	pk.tgid = s->tgid;
	__builtin_memcpy(pk.comm, s->comm, sizeof(pk.comm));
	pv = bpf_map_lookup_elem(&procs, &pk);
	if (!pv) {
		bpf_map_update_elem(&procs, &pk, &pzero, BPF_NOEXIST);
		pv = bpf_map_lookup_elem(&procs, &pk);
	}
	if (pv) {
		if (write) {
			__sync_fetch_and_add(&pv->writes, 1);
			__sync_fetch_and_add(&pv->write_bytes, s->bytes);
		} else {
			__sync_fetch_and_add(&pv->reads, 1);
			__sync_fetch_and_add(&pv->read_bytes, s->bytes);
		}
		__sync_fetch_and_add(&pv->lat_ns, delta);
		if (delta > pv->lat_max_ns)
			pv->lat_max_ns = delta;
		barrier_var(slot);
		if (slot < MAX_SLOTS)
			__sync_fetch_and_add(&pv->slots[slot], 1);
	}

	bpf_map_delete_elem(&start, &key);
	(void)zero;
	(void)nr_bytes;
	return 0;
}
