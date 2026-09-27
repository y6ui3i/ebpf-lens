//go:build ignore

// proclife: streams process start (exec), exit, and OOM kill as events into a ring buffer.
// Polling-based monitoring cannot see processes that live shorter than the polling interval, but here we catch each one.
// Command-line arguments are not captured because they can contain passwords and the like (only the executable path and name).

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#define TASK_COMM_LEN 16
#define FILENAME_LEN 128

#define KIND_EXEC 1
#define KIND_EXIT 2
#define KIND_OOM 3
#define KIND_SIGNAL 4

char LICENSE[] SEC("license") = "Dual BSD/GPL";

struct event {
	u64 ts; // bpf_ktime_get_ns(CLOCK_MONOTONIC)
	u32 kind;
	u32 pid;
	u32 ppid;
	u32 uid;
	s32 exit_code; // exit: task->exit_code as is (the high 8 bits are the exit status, the low 7 bits the signal)
	u32 trigger_pid; // oom: the process whose memory request triggered the OOM
	u64 lifetime_ns; // exit: time elapsed since fork
	u64 total_pages; // oom: number of pages in the constrained scope
	u32 memcg; // oom: 1 if the OOM was caused by a cgroup limit
	u32 _pad;
	char comm[TASK_COMM_LEN];
	char trigger_comm[TASK_COMM_LEN];
	char filename[FILENAME_LEN];
};

// Make sure struct event is emitted into BTF so bpf2go can generate the Go type
const struct event *unused_event __attribute__((unused));

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 1 << 20);
} events SEC(".maps");

// Number of events dropped because the ring buffer overflowed. User space reads it and shows it in the UI
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 1);
	__type(key, u32);
	__type(value, u64);
} dropped SEC(".maps");

static __always_inline void count_drop(void)
{
	u32 zero = 0;
	u64 *d = bpf_map_lookup_elem(&dropped, &zero);

	if (d)
		*d += 1;
}

static __always_inline struct event *reserve(u32 kind, struct task_struct *t)
{
	struct event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);

	if (!e) {
		count_drop();
		return NULL;
	}
	__builtin_memset(e, 0, sizeof(*e));
	e->ts = bpf_ktime_get_ns();
	e->kind = kind;
	e->pid = BPF_CORE_READ(t, tgid);
	e->ppid = BPF_CORE_READ(t, real_parent, tgid);
	e->uid = BPF_CORE_READ(t, real_cred, uid.val);
	bpf_probe_read_kernel_str(e->comm, sizeof(e->comm), BPF_CORE_READ(t, group_leader, comm));
	return e;
}

SEC("tp_btf/sched_process_exec")
int BPF_PROG(handle_exec, struct task_struct *p, pid_t old_pid, struct linux_binprm *bprm)
{
	struct event *e = reserve(KIND_EXEC, p);

	if (!e)
		return 0;
	bpf_probe_read_kernel_str(e->filename, sizeof(e->filename), BPF_CORE_READ(bprm, filename));
	bpf_ringbuf_submit(e, 0);
	return 0;
}

SEC("tp_btf/sched_process_exit")
int BPF_PROG(handle_exit, struct task_struct *p, bool group_dead)
{
	struct event *e;

	// Ignore thread exits; only capture when the whole process has exited
	if (!group_dead)
		return 0;
	e = reserve(KIND_EXIT, p);
	if (!e)
		return 0;
	e->exit_code = BPF_CORE_READ(p, exit_code);
	e->lifetime_ns = e->ts - BPF_CORE_READ(p, start_time);
	bpf_ringbuf_submit(e, 0);
	return 0;
}

// Who sent a terminating signal to whom. QEMU handles SIGTERM and exits 0, so without this a "virsh destroy"
// is indistinguishable from a guest shutdown. Only signals that stop a process are recorded, only when they
// were actually queued (result 0), and never when a process signals itself (kill -TERM $$).
SEC("tp_btf/signal_generate")
int BPF_PROG(handle_signal, int sig, struct kernel_siginfo *info, struct task_struct *task, int group, int result)
{
	struct task_struct *cur;
	struct event *e;

	if (result != 0)
		return 0;
	if (sig != 9 && sig != 15 && sig != 2 && sig != 1 && sig != 3) // KILL TERM INT HUP QUIT
		return 0;
	cur = (struct task_struct *)bpf_get_current_task_btf();
	if (BPF_CORE_READ(cur, tgid) == BPF_CORE_READ(task, tgid))
		return 0;
	e = reserve(KIND_SIGNAL, task);
	if (!e)
		return 0;
	e->exit_code = sig;
	e->trigger_pid = BPF_CORE_READ(cur, tgid);
	bpf_probe_read_kernel_str(e->trigger_comm, sizeof(e->trigger_comm), BPF_CORE_READ(cur, group_leader, comm));
	bpf_ringbuf_submit(e, 0);
	return 0;
}

SEC("fentry/oom_kill_process")
int BPF_PROG(handle_oom, struct oom_control *oc, const char *message)
{
	struct task_struct *victim = BPF_CORE_READ(oc, chosen);
	struct task_struct *cur = (struct task_struct *)bpf_get_current_task_btf();
	struct event *e;

	if (!victim)
		return 0;
	e = reserve(KIND_OOM, victim);
	if (!e)
		return 0;
	e->trigger_pid = BPF_CORE_READ(cur, tgid);
	bpf_probe_read_kernel_str(e->trigger_comm, sizeof(e->trigger_comm), BPF_CORE_READ(cur, group_leader, comm));
	e->total_pages = BPF_CORE_READ(oc, totalpages);
	e->memcg = BPF_CORE_READ(oc, memcg) ? 1 : 0;
	bpf_ringbuf_submit(e, 0);
	return 0;
}
