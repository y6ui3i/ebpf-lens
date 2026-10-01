# ADR 0004: A program on the lock tracepoints, or in interrupt context, takes no lock

Status: Accepted (2026-10-01)

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
the pre-fix build was left running with a load cycle every five minutes. After 50 minutes it locked up again,
panicked, and kdump saved the kernel log with a backtrace of every CPU.

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
resilient_queued_spin_lock_slowpath+0x514      <- waits forever
htab_lock_bucket
htab_lru_map_delete_elem                       <- same map, same key: the same bucket
bpf_prog_..._handle_contention_end             <- lockwait's program, nested
__traceiter_contention_end
resilient_queued_spin_lock_slowpath+0x4d6      <- the bucket lock is acquired: it fires contention_end for itself
htab_lock_bucket
htab_lru_map_delete_elem                       <- delete this thread's start-time entry
bpf_prog_..._handle_contention_end             <- lockwait's program
__traceiter_contention_end
native_queued_spin_lock_slowpath+0x1b3         <- jiffies_lock is acquired: contention_end fires
_raw_spin_lock
tick_do_update_jiffies64
tick_nohz_update_jiffies
tick_irq_enter
irq_enter_rcu
sysvec_apic_timer_interrupt
```

CPU 1 is stuck the same way through `handle_contention_begin` (`htab_lru_map_update_elem`, then a nested
`handle_contention_end`). The only BPF programs named anywhere in the log are `handle_contention_begin` and
`handle_contention_end`. `irqlat` and the NVIDIA driver appear in no stack.

So `lockwait` did it alone:

1. `jiffies_lock` is contended when the CPUs wake from idle together. Acquiring it fires `lock:contention_end`.
2. `lockwait`'s program deletes the waiter's start time from an LRU hash map keyed by thread id.
3. The map's bucket lock — BPF's resilient queued spinlock, rqspinlock — is contended too. Its slow path fires
   `lock:contention_end` for itself once it has the lock.
4. The same program runs again, nested, on the same CPU, with the same thread id, and goes for the same bucket:
   the lock this CPU has just taken.
5. The CPU never releases `jiffies_lock`. Every other CPU stops behind it.

Everything observed fits: the timing (idle after load is when the tick interrupts contend `jiffies_lock`), the
`clocksource: Long readout interval` stalls of 1–7 s before each lockup (rqspinlock timing out and letting the
nested attempt fail, in quarter-second steps), and the apparent need for `irqlat` and the GPU probe (both add
map-lock contention and wake-ups, so removing either lowered the odds enough to survive a 4-minute trial; the VM
"not reproducing" was a 15-minute sample of something that took 50 minutes on the host).

Older kernels would not have locked up here: before hash maps moved to rqspinlock, a per-CPU re-entrancy guard
made the nested map operation fail with `-EBUSY`. The guard was dropped in favour of rqspinlock's own deadlock
detection, which did not get this case out within the hard-lockup window.

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
- Not reported upstream. The backtrace above is what there is; the kernel log is kept on the test host.
