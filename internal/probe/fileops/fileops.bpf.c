//go:build ignore

// fileops: two things about files that are invisible from the outside and decisive from the inside.
//   - Opens that fail (the raw syscall tracepoints, filtered to open / openat / openat2: do_sys_openat2 and
//     do_filp_open are inlined on recent kernels and cannot be traced): which process asked for which path and
//     got which errno. Half of all misconfigurations show up here first — a config file that
//     is not there, a certificate the service user may not read, a read-only mount, a full file table — long
//     before anything crashes. Every failure is counted by errno; each (process, errno, path) gets a row
//   - fsync waits (fentry/fexit on do_fsync, where fsync and fdatasync end up): how long the caller sat in the
//     call, per process and per file. A database commit is an fsync; when the disk screen says the SSD stalled,
//     this says who felt it and on which file. vfs_fsync_range would be more general (io_uring, nfsd) but is
//     inlined on recent kernels and never fires; do_fsync is what the syscalls call and is in kallsyms

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#define MAX_SLOTS 27
#define TASK_COMM_LEN 16
#define PATH_LEN 96
#define NAME_LEN 32
#define MAX_ERRNO 256

char LICENSE[] SEC("license") = "Dual BSD/GPL";

struct proc_key {
	u32 tgid;
	char comm[TASK_COMM_LEN];
};

// Per process: fsync calls (count, total, max, histogram) and failed opens
struct proc_val {
	u64 fsyncs;
	u64 lat_ns;
	u64 lat_max_ns;
	u64 open_fails;
	u64 slots[MAX_SLOTS];
};

// One failed open: who, which errno, which path (as the caller gave it: relative paths stay relative)
struct open_key {
	u32 tgid;
	u32 err; // positive errno
	char comm[TASK_COMM_LEN];
	char path[PATH_LEN];
};

// One fsynced file: its name and its parent directory's name (enough to tell a WAL from its DB). Two fixed
// fields rather than one joined string: the verifier rejects a write at a variable offset into the stack
struct file_key {
	char dir[NAME_LEN];
	char name[NAME_LEN];
};

struct file_val {
	u64 fsyncs;
	u64 lat_ns;
	u64 lat_max_ns;
};

// An fsync in progress on one thread
struct start {
	u64 ts;
	char dir[NAME_LEN];
	char name[NAME_LEN];
};

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 10240);
	__type(key, u32); // tid
	__type(value, struct start);
} start SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 4096);
	__type(key, struct proc_key);
	__type(value, struct proc_val);
} procs SEC(".maps");

// The path argument of an open in progress on one thread (read at exit, when the result is known)
struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 10240);
	__type(key, u32); // tid
	__type(value, u64); // const char __user *
} open_start SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 8192);
	__type(key, struct open_key);
	__type(value, u64);
} opens SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, MAX_ERRNO);
	__type(key, u32);
	__type(value, u64);
} open_errs SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 4096);
	__type(key, struct file_key);
	__type(value, struct file_val);
} files SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, MAX_SLOTS);
	__type(key, u32);
	__type(value, u64);
} hist SEC(".maps");

// Zero values live in .rodata: the 512-byte stack cannot hold a struct with a 27-slot histogram
static const struct proc_val pzero;
static const struct file_val fzero;
static const u64 zero64;

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

static __always_inline struct proc_val *proc_val_of(struct task_struct *t)
{
	struct proc_key k = {};
	struct proc_val *v;

	k.tgid = t->tgid;
	bpf_probe_read_kernel_str(k.comm, sizeof(k.comm), t->group_leader->comm);
	v = bpf_map_lookup_elem(&procs, &k);
	if (v)
		return v;
	bpf_map_update_elem(&procs, &k, &pzero, BPF_NOEXIST);
	return bpf_map_lookup_elem(&procs, &k);
}

// x86-64 syscall numbers
#define NR_OPEN 2
#define NR_OPENAT 257
#define NR_OPENAT2 437

SEC("tp_btf/sys_enter")
int BPF_PROG(handle_sys_enter, struct pt_regs *regs, long id)
{
	u32 tid = (u32)bpf_get_current_pid_tgid();
	u64 filename;

	if (id == NR_OPENAT || id == NR_OPENAT2)
		filename = PT_REGS_PARM2_CORE_SYSCALL(regs);
	else if (id == NR_OPEN)
		filename = PT_REGS_PARM1_CORE_SYSCALL(regs);
	else
		return 0;
	bpf_map_update_elem(&open_start, &tid, &filename, BPF_ANY);
	return 0;
}

SEC("tp_btf/sys_exit")
int BPF_PROG(handle_sys_exit, struct pt_regs *regs, long ret)
{
	u32 tid = (u32)bpf_get_current_pid_tgid();
	long id = BPF_CORE_READ(regs, orig_ax);
	struct task_struct *t;
	struct proc_val *pv;
	struct open_key k = {};
	u64 *filename, *cnt;
	u32 err;

	if (id != NR_OPENAT && id != NR_OPENAT2 && id != NR_OPEN)
		return 0;
	filename = bpf_map_lookup_elem(&open_start, &tid);
	if (!filename)
		return 0;
	if (ret >= 0) {
		bpf_map_delete_elem(&open_start, &tid);
		return 0;
	}
	err = -ret;
	if (err == 4 || err == 11) // EINTR / EAGAIN: not a failure of the file
		return 0;
	if (err < MAX_ERRNO) {
		cnt = bpf_map_lookup_elem(&open_errs, &err);
		if (cnt)
			*cnt += 1;
	}
	t = (struct task_struct *)bpf_get_current_task_btf();
	k.tgid = t->tgid;
	k.err = err;
	bpf_probe_read_kernel_str(k.comm, sizeof(k.comm), t->group_leader->comm);
	bpf_probe_read_user_str(k.path, sizeof(k.path), (const void *)*filename);
	bpf_map_delete_elem(&open_start, &tid);
	cnt = bpf_map_lookup_elem(&opens, &k);
	if (!cnt) {
		bpf_map_update_elem(&opens, &k, &zero64, BPF_NOEXIST);
		cnt = bpf_map_lookup_elem(&opens, &k);
	}
	if (cnt)
		__sync_fetch_and_add(cnt, 1);
	pv = proc_val_of(t);
	if (pv)
		__sync_fetch_and_add(&pv->open_fails, 1);
	return 0;
}

// file_name_of fills the name and the parent directory's name of the file behind fd in the current task
static __always_inline void file_name_of(struct task_struct *t, unsigned int fd, struct start *s)
{
	struct file **fdt;
	struct file *f = NULL;
	struct dentry *d, *parent;

	fdt = BPF_CORE_READ(t, files, fdt, fd);
	if (!fdt)
		return;
	if (bpf_probe_read_kernel(&f, sizeof(f), fdt + fd) || !f)
		return;
	d = BPF_CORE_READ(f, f_path.dentry);
	bpf_probe_read_kernel_str(s->name, sizeof(s->name), BPF_CORE_READ(d, d_name.name));
	parent = BPF_CORE_READ(d, d_parent);
	if (parent && parent != d) // a file at the root is its own parent
		bpf_probe_read_kernel_str(s->dir, sizeof(s->dir), BPF_CORE_READ(parent, d_name.name));
}

// static int do_fsync(unsigned int fd, int datasync)
SEC("fentry/do_fsync")
int BPF_PROG(handle_fsync, unsigned int fd, int datasync)
{
	u32 tid = (u32)bpf_get_current_pid_tgid();
	struct task_struct *t = (struct task_struct *)bpf_get_current_task_btf();
	struct start s = {};

	s.ts = bpf_ktime_get_ns();
	file_name_of(t, fd, &s);
	bpf_map_update_elem(&start, &tid, &s, BPF_ANY);
	return 0;
}

SEC("fexit/do_fsync")
int BPF_PROG(handle_fsync_ret, unsigned int fd, int datasync, int ret)
{
	u32 tid = (u32)bpf_get_current_pid_tgid();
	struct start *s = bpf_map_lookup_elem(&start, &tid);
	struct task_struct *t;
	struct proc_val *pv;
	struct file_key fk = {};
	struct file_val *fv;
	u64 delta, *cnt;
	u32 slot;

	if (!s)
		return 0;
	delta = bpf_ktime_get_ns() - s->ts;
	slot = log2_u64(delta / 1000);
	if (slot >= MAX_SLOTS)
		slot = MAX_SLOTS - 1;
	cnt = bpf_map_lookup_elem(&hist, &slot);
	if (cnt)
		*cnt += 1;

	__builtin_memcpy(fk.dir, s->dir, sizeof(fk.dir));
	__builtin_memcpy(fk.name, s->name, sizeof(fk.name));
	fv = bpf_map_lookup_elem(&files, &fk);
	if (!fv) {
		bpf_map_update_elem(&files, &fk, &fzero, BPF_NOEXIST);
		fv = bpf_map_lookup_elem(&files, &fk);
	}
	if (fv) {
		__sync_fetch_and_add(&fv->fsyncs, 1);
		__sync_fetch_and_add(&fv->lat_ns, delta);
		if (delta > fv->lat_max_ns)
			fv->lat_max_ns = delta;
	}

	t = (struct task_struct *)bpf_get_current_task_btf();
	pv = proc_val_of(t);
	if (pv) {
		__sync_fetch_and_add(&pv->fsyncs, 1);
		__sync_fetch_and_add(&pv->lat_ns, delta);
		if (delta > pv->lat_max_ns)
			pv->lat_max_ns = delta;
		// The verifier loses track of slot's range across the calls in between; re-check right before use
		barrier_var(slot);
		if (slot < MAX_SLOTS)
			__sync_fetch_and_add(&pv->slots[slot], 1);
	}
	bpf_map_delete_elem(&start, &tid);
	return 0;
}
