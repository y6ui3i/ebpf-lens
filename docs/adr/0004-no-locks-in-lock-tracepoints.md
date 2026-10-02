# ADR 0004: A program on the lock tracepoints, or in interrupt context, takes no lock

Status: Accepted (2026-10-01; revised 2026-10-02: two copies of `lockwait`, two maps)

## Context

On 2026-10-01 the test host (Ubuntu 26.04, kernel 7.0.0-34, 8 CPUs) hard-locked four times while the lock probe
(`lockwait`) and the interrupt probe (`irqlat`) were being added. Each time it happened 1–2 minutes after a load
burst, when the machine was idle again, and the first three times it left nothing: no oops, no pstore record, an
NMI watchdog that said nothing.

Elimination (one configuration per 4-minute trial) made it look like a three-way combination — `irqlat`,
`lockwait`, and the GPU probe — and, because a VM on the same kernel survived, like something only the NVIDIA
driver's interrupt could complete. `irqlat` was rewritten without locking maps, `lockwait`'s spinlock path was
moved to a per-CPU slot, the lockups stopped, and the NVIDIA explanation was written into the README.

That explanation was wrong. With `kernel.hardlockup_panic=1`, `hardlockup_all_cpu_backtrace=1` and kdump armed,
two copies of the pre-fix build were left running (one sending to the server, one printing text) with a load
cycle every five minutes. After 50 minutes it locked up again, panicked, and kdump saved the kernel log with a
backtrace of every CPU. In the morning, too, two copies were probably running: the resident agent and a test
build on the verification port (not verified).

## What the backtrace says

Six CPUs are waiting for `jiffies_lock`, each woken from idle by its timer interrupt:

```
native_queued_spin_lock_slowpath
_raw_spin_lock
tick_do_update_jiffies64
tick_nohz_update_jiffies
tick_irq_enter
irq_enter_rcu
sysvec_apic_timer_interrupt
```

CPU 7 holds it. Read from the bottom:

```
resilient_queued_spin_lock_slowpath+0x514      <- waits forever (-EDEADLK)
htab_lock_bucket
htab_lru_map_delete_elem                       <- the other copy's map: a different bucket lock
bpf_prog_..._handle_contention_end             <- the other copy of lockwait's program, nested
__traceiter_contention_end
resilient_queued_spin_lock_slowpath+0x4d6      <- this attempt gives up (error path) and fires contention_end itself
htab_lock_bucket
htab_lru_map_delete_elem                       <- delete this thread's start-time entry
bpf_prog_..._handle_contention_end             <- one copy of lockwait's program
__traceiter_contention_end
native_queued_spin_lock_slowpath+0x1b3         <- jiffies_lock is acquired: contention_end fires
_raw_spin_lock
tick_do_update_jiffies64
tick_nohz_update_jiffies
tick_irq_enter
irq_enter_rcu
sysvec_apic_timer_interrupt
```

CPU 1 is stuck the same way through `handle_contention_begin`: `htab_lru_map_update_elem` gets the bucket lock
through the slow path (`+0x305`, the success path, `contention_end` with 0), and the nested
`handle_contention_end` goes for a bucket lock again. The only BPF programs named anywhere in the log are `handle_contention_begin` and
`handle_contention_end`. `irqlat` and the NVIDIA driver appear in no stack.

The two `handle_contention_end` frames on CPU 7 carry the same tag, because the tag is a hash of the instructions
and both copies load the same program. They cannot be one program: a tracepoint program that is already running
on a CPU is skipped when it fires again there (the kernel counts the skip in `recursion_misses`, which is how the
nesting was measured in the VM). The registers say the same about the maps. In `htab_lru_map_delete_elem`, R12
holds the hash and RBX the bucket. Both CPUs delete the entry of thread 0 (the idle task), yet the hashes differ
(`0x5002e440` on CPU 1, `0xe563f795` on CPU 7), and the bucket arrays computed back from RBX start at two different
page-aligned addresses: two maps, each with its own hash seed.

So `lockwait` did it, without `irqlat` or NVIDIA, but with two copies of itself:

1. `jiffies_lock` is contended when the CPUs wake from idle together. Acquiring it fires `lock:contention_end`.
2. One copy's program deletes the waiter's start time from its LRU hash map keyed by thread id.
3. The map's bucket lock — BPF's resilient queued spinlock, rqspinlock — is contended too. Its slow path fires
   `lock:contention_end` itself, both when it gets the lock and when it gives up.
4. The other copy's program runs, nested, on the same CPU, and goes for a bucket lock of its own map.
5. Two CPUs end up at the head of the queues of two different bucket locks, each having detected a deadlock, and
   neither returns (next section). CPU 7 never releases `jiffies_lock`, and every other CPU stops behind it.

Everything observed fits: the timing (idle after load is when the tick interrupts contend `jiffies_lock`), the
`clocksource: Long readout interval` stalls of 1–7 s before each lockup (the same stall, ended by another waiter arriving), and the apparent need for `irqlat` and the GPU probe (both add
map-lock contention and wake-ups, so removing either lowered the odds enough to survive a 4-minute trial; the VM
"not reproducing" was a 15-minute sample of something that took 50 minutes on the host).

### Why the kernel did not get itself out

rqspinlock exists to survive exactly this: it detects AA and ABBA deadlocks and times out after
`NSEC_PER_SEC / 4`. It did detect this one. In the dump both stuck CPUs have `RAX = 0xffffffdd` (`-EDEADLK`)
and `RIP = resilient_queued_spin_lock_slowpath+0x514`, and the disassembly of the running kernel puts that
address in this loop of the slow path (`kernel/bpf/rqspinlock.c`, v7.0):

```c
	/* Disable queue destruction when we detect deadlocks. */
	if (ret == -EDEADLK) {
		if (!next)
			next = smp_cond_load_relaxed(&node->next, (VAL));   /* <- here, forever */
		arch_mcs_spin_unlock_contended(&next->locked);
		goto err_release_node;
	}
```

The waiter at the head of the queue has seen the deadlock and wants to leave, but first waits for a next waiter
to hand the queue to. The lock word still has this CPU's node as the tail: there is no next waiter, and none can
arrive, because every other CPU is behind `jiffies_lock`, which this CPU holds. The 1–7 s stalls before each
lockup were the same wait ended by a waiter that did arrive.

This is a kernel bug and it is already fixed upstream: 7a3c0289c3c8 "rqspinlock: Reset tail when preserving queue
on deadlock" (2026-08-06, v7.2-rc7; in stable 7.1.y since 2026-08-19), which resets the tail instead of waiting.
Its commit message calls the indefinite stall theoretical and reachable only through ABBA. Here it was reached
through the contention tracepoints, with two copies of the same program nesting into each other. The two maps fit
that: the nested attempt is on a different lock, so the AA check made before queueing has nothing to catch, and
what is left is the ABBA case the commit describes. A single copy does not get here, because its nested run is
skipped by the recursion guard.

The versions, checked in the source of each branch:

| Kernel | Nested map operation from the tracepoint | Result |
|---|---|---|
| up to v6.14 | per-CPU `map_locked` guard in `htab_lock_bucket()` returns `-EBUSY` | fails, harmless |
| v6.15 – v6.18 | bucket lock is rqspinlock, whose slow path fires `contention_begin` / `contention_end`; a deadlock at the head of the queue flushes the queue | not tested; the unbounded wait is not in the code |
| v6.19, v7.0, v7.1 before the fix | 7bd6e5ce5be6 keeps the queue on a deadlock and waits for a next waiter | **can hard-lock** |
| v7.1.y with the fix, v7.2 | tail reset | fixed |

Upstream 6.19.y and 7.0.y reached end of life without the fix (6.19.14, 7.0.14). Ubuntu 26.04's
7.0.0-34.34 is based on 7.0.14 and its running binary has the old loop; the changelog of 7.0.0-38.38
(resolute-updates, 2026-09) does not list the fix either. The exposure goes by the booted kernel,
not the distribution (`uname -r`): Amazon Linux 2023's default 6.18 is outside the range, an Ubuntu 26.04 host is
inside it.

## Decision

1. **A program attached to `lock:contention_begin` / `contention_end` must not take a lock on the spinlock
   path.** `lockwait` keeps the start of a spinlock wait in a per-CPU array slot and attributes spinlock
   contention per kind only. Sleeping locks (mutex, rwsem) are process context and keep the per-thread LRU map
   and the per-process rows; the nested events their map operations cause are spinlock events and take the
   per-CPU path. `perf lock contention`'s BPF skeleton is built the same way.
2. **A program that runs in interrupt context uses only per-CPU arrays.** `irqlat` has no hash map, no LRU, no
   string copy; IRQ names come from `/proc/interrupts`. It was not the cause, but locking maps in hardirq and
   softirq context are what raised the odds, and there is nothing they buy that a per-CPU array does not.
3. **When a host dies silently, make it talk first.** `hardlockup_panic`, all-CPU backtraces and kdump before any
   elimination. Half a day of trials produced a correlation and a wrong story; one dump produced the cause.

## Consequences

- Spinlock contention has no per-process rows on the locks screen (in interrupt context the current task is
  whoever was interrupted anyway).
- A new probe that attaches to a lock tracepoint, a scheduler tracepoint that can fire under a lock, or anything
  in hardirq / softirq context gets reviewed against this ADR before it is merged.
- `ebpflens-agent -disable` and `cmd/probe-only` stay in the tree as the tools for this kind of isolation.
- Two agents on one host is an ordinary state (the resident one and a test build), so a probe has to be safe
  next to another copy of itself.
- The kernel side is fixed upstream; what is missing is the fix in Ubuntu 26.04's 7.0 kernel. Not reported:
  Ubuntu keeps picking fixes for 7.0 from newer stable branches, so check the changelog of each new kernel.
- In a VM on the same kernel (8 vCPUs), one copy of the pre-fix build ran for 3 hours without a lockup. With two
  copies, nested programs and rqspinlock failures (`-EDEADLK`, `-ETIMEDOUT`) appeared within two minutes, but this
  stall did not. The VM did hard-lock once, through a different kernel bug: the LRU map's list lock, a plain
  spinlock in 7.0, re-entered from the same tracepoints. That one is fixed upstream in 89edbdfc5d03 and in
  Ubuntu's 7.0.0-38. Decision 1 closes both.
