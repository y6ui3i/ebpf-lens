# ADR 0001: Everyone an SRE — explain incidents so that whoever is on call can act

- Status: Accepted
- Date: 2026-09-26

## Context

eBPFLens already turns raw kernel data into meaning: the Lens Summary states a verdict in plain language, and the per-resource pages show cause and impact. While planning VM monitoring (roadmap item 8) we asked a more basic question: **what does the person on call actually need to know?**

In incident response the questions come in roughly this order:

1. Is it still happening, and how far does the impact reach? (one VM, a whole host, already recovered)
2. Whose problem is it? (application, host / infrastructure, hardware vendor, or a human action) — this decides whom to call next, which is the real purpose of first-level triage
3. What should I do right now? (restart, move the workload, wait, call the vendor)
4. What is the evidence that my side is fine? (clear responsibility boundaries end the finger-pointing between teams and vendors)
5. Why did it happen, and will it happen again? (the post-incident review)

The first five minutes need 1–3; root cause (5) can wait. Experienced SREs answer 2–4 in their heads by collecting evidence from several layers. People who are not kernel experts — someone woken up at 3 a.m., a monitoring operator following a runbook, the owner of a service that runs *inside* a VM — cannot, and today's tools do not help them.

A concrete example: on the Proxmox forum, "my VM was killed by the OOM killer, what was the real cause?" comes up again and again, and the usual answer is "grep dmesg". The kernel does log everything needed, but nobody turns it into words an operator can act on, in real time, before the log rotates away. Competing tools cover pieces (vmtop measures per-vCPU steal, Netdata shows per-VM cgroup usage and OOM-kill counts, Trace Compass correlates host and guest traces offline), but none explains *why a VM stopped and what to do next*.

## Decision

**The Lens Summary grows into an incident brief that lets anyone on call act like an SRE.** The tool does the reasoning an SRE does in their head and shows its work.

### Three layers

| Layer | Content | Audience |
|---|---|---|
| 1. Situation and next step | "VM `web-02` stopped at 19:42 and is still down. **It is safe to restart it.** The cause (host memory overcommit) is still there, so it may happen again during tonight's 02:00 backup." | anyone |
| 2. Triage and evidence | Owner: **infrastructure (host configuration)**, confidence: high. Numbered evidence. "The application side looks healthy," with its own evidence. | whoever escalates |
| 3. Details | Timeline, heatmaps, per-process tables | specialists |

Each incident also produces **a message ready to send** to the owning team or vendor, with the evidence attached. Writing that message is where people without the background struggle most.

### Principles

1. **Inference is rule-based and deterministic.** "Host OOM, triggered by `vzdump`" → "infrastructure" is decided by explicit rules over collected facts. If an LLM is ever used, it only phrases the text; it never adds facts. This keeps every conclusion traceable to evidence.
2. **Say "unknown" when unsure.** When confidence is low, do not guess; say what could not be determined and what to check next. A confident wrong diagnosis is worse than none.
3. **Every recommended action comes with its reason.** An instruction without a reason cannot be noticed when it is wrong.
4. **Evidence comes from several sources, with eBPF first.** eBPF gives real-time, structured facts. The kernel log (`/dev/kmsg`) corroborates them and adds what eBPF does not hook (ECC / MCE errors, I/O errors, oopses, hung tasks). libvirt tells human actions apart; an agent inside the guest tells application problems apart. The brief must still work with eBPF alone.
5. **Respect the reader.** The brief is written for someone capable who lacks this particular background, not for someone assumed to be incompetent. Plain words, no jargon without explanation, no blame.

### First scenario: why did this VM stop?

The first implementation targets VM post-mortems on a KVM host, because every part of the brief has a clear answer there:

- situation: which VM stopped, when, and whether it is still down (QEMU PID → libvirt domain name)
- triage: application inside the guest / host resources / QEMU itself / guest OS / hardware / human action
- next step: restart, move, fix the host configuration, or call the vendor
- evidence: host OOM with the triggering process and whether it was a cgroup limit or a machine-wide shortage (proclife), reclaim stalls before the kill (memstall), QEMU exit signal and core dump (proclife), kernel log lines, libvirt's stop reason

Steal-time attribution (which process or VM took the CPU from a vCPU) follows as the second step; that is where eBPFLens goes beyond vmtop.

## Consequences

- Rules need a place to live and tests with recorded evidence, so that a change in one rule does not silently change other verdicts.
- Reading `/dev/kmsg` needs one more capability for the agent (`CAP_SYSLOG`). Only the lines that matter are forwarded, never the whole log.
- Kernel log formats change between versions; parsing is treated as best effort, and the brief degrades gracefully to eBPF-only evidence.
- The test VM (`lab/create-vm.sh`) becomes the main way to verify each scenario: every rule gets at least one reproduced incident.
