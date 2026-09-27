# eBPFLens operator's manual

[日本語版](manual.ja.md)

This is for the person on call: capable, busy, not a kernel expert. It says what eBPFLens can see, what each screen means, and what to do when it turns yellow or red. Design background is in [ADR 0001](adr/0001-everyone-an-sre.md); build and deployment are in the [README](../README.md).

## 1. eBPFLens in five minutes

eBPFLens watches Linux hosts from inside the kernel with eBPF and turns what it sees into plain statements: *whether* something is wrong, *what*, *who caused it*, *who is affected*, and *what to do*. It does not poll averages; it counts every scheduler switch, every memory-reclaim stall, every process start and exit, every OOM kill, and every terminating signal, so it also catches what happens between two polls.

Open the dashboard (`http://<server>:8080`). Read it top to bottom:

1. **Lens Summary** — one line with a level and a headline (e.g. *Warning · Processes are competing for CPU*), then one line per area: **CPU**, **Memory**, **Processes**, **VM**.
2. **Recent incidents** — everything that opened in the last 24 hours, newest first.
3. **Status by resource** — a grid of resources × *Utilization / Saturation / Errors*. Every cell links to a detail screen.

If the headline is green, nothing needs you. If it is not, the headline names the area; the finding line under it says what happened and, where known, why; click through the cell or the menu for the evidence.

Language: **EN / 日本語** in the top bar. Host: the selector in the top bar (one server can watch several hosts).

## 2. Installing and deploying

### What you need

- **Monitored hosts**: Linux with kernel BTF (`/sys/kernel/btf/vmlinux` exists — Ubuntu, Fedora, RHEL 9, Debian 12 and later ship it). Tested on Ubuntu 26.04 / kernel 7.0. The agent is one static binary; nothing else is installed on the host.
- **A build machine** (same architecture, any modern Linux): Go 1.25+, clang, llvm, libbpf-dev, bpftool. The UI is built once with Node 22 and embedded into the server binary, so browsers need nothing.
- **A server**: any Linux box the hosts can reach on one TCP port (default 8080). It can be one of the monitored hosts. SQLite is built in; no database service.
- **Network**: agents → server `:8080` (HTTP), browsers → server `:8080`. There is no authentication (§7): keep this port inside a trusted network or behind a reverse proxy that adds it.

### Build

```bash
git clone https://github.com/yoshiharu-ishii/ebpf-lens && cd ebpf-lens
make web      # on a machine with Node: generates TS types, builds the UI into internal/webui/dist
make build    # on Linux: vmlinux.h from this kernel's BTF, BPF objects, then bin/ebpflens-agent and bin/ebpflens-server
```

`bin/` now holds two binaries. Copy `ebpflens-agent` to every host you want to watch; the server goes wherever you decided.

### Deploy the server (systemd)

On the server machine, from the repository:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin ebpflens
sudo usermod -aG ebpflens "$USER"            # optional: lets you read the DB with sqlite3
make install                                 # /opt/ebpflens/bin/*, /etc/systemd/system/ebpflens-{server,agent}.service
sudo systemctl enable --now ebpflens-server
```

The unit runs the server as `ebpflens` with no privileges, listening on `:8080`, DB at `/var/lib/ebpflens/ebpflens.db` (24 h of samples, 7 days of events, 30 days of incidents). To put the DB on another disk, add a drop-in — never on NFS:

```ini
# /etc/systemd/system/ebpflens-server.service.d/10-local-db.conf
[Unit]
RequiresMountsFor=/data/ebpflens
[Service]
ExecStart=
ExecStart=/opt/ebpflens/bin/ebpflens-server -addr :8080 -db /data/ebpflens/ebpflens.db
ReadWritePaths=/data/ebpflens
```

To change thresholds or add notifications, put the extra flags on the same `ExecStart` line (`-triggers /etc/ebpflens/triggers.json`, `-webhook https://… -webhook-format slack`; see §8), then `sudo systemctl daemon-reload && sudo systemctl restart ebpflens-server`.

### Deploy an agent on each host (systemd)

On every monitored host:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin ebpflens
sudo install -d /opt/ebpflens/bin
sudo install -m 0755 ebpflens-agent /opt/ebpflens/bin/
sudo install -m 0644 deploy/systemd/ebpflens-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Edit the unit's `ExecStart` so `-server` points at your server (`-server http://SERVER:8080`; the shipped unit assumes the server is local), then `sudo systemctl enable --now ebpflens-agent`. The agent runs as `ebpflens` with only `CAP_BPF` and `CAP_PERFMON` — not root. The host appears in the dashboard's host selector under its hostname (`-host NAME` overrides). One server can watch many hosts; each host's agent is independent, and a host that stops reporting becomes an *Agent stopped reporting* incident after 30 s.

### Check that it works

```bash
systemctl status ebpflens-server ebpflens-agent
journalctl -u ebpflens-agent -n 20            # no "load bpf objects" errors
curl -s http://SERVER:8080/api/hosts          # every host with its last sample time
```

Open `http://SERVER:8080` — within a few seconds the Lens Summary should read green, with the CPU line giving a wait time in microseconds. If a host is missing: the agent is not running, cannot reach the server, or the kernel has no BTF (the agent log will say which).

### Update

Build the new binaries, then on the server `make install && sudo systemctl restart ebpflens-server`, and on each host copy the new agent to `/opt/ebpflens/bin/` and `sudo systemctl restart ebpflens-agent`. Incidents and history survive a server restart (§5 explains how open incidents are treated).

### Remove

`sudo systemctl disable --now ebpflens-agent` (and `ebpflens-server`), delete `/opt/ebpflens`, the units, `/var/lib/ebpflens` (the DB), and the `ebpflens` user. The agent leaves nothing else on a host; eBPF programs are detached when it stops.

## 3. Reading the dashboard

### Levels

| Mark | Level | Meaning |
|---|---|---|
| ● | OK | within the normal range |
| ▲ | Caution | worth a look; the threshold was crossed for a few seconds, or something abnormal but survivable happened |
| ◆ | Warning | act: a hard threshold was crossed for a while, a process was killed or is crash-looping, a host or VM stopped |

The overall level is the **worst area**. For the headline, ties go in this order: a host that stopped reporting, then VM, then CPU, memory, processes — because when the agent is silent nothing else is fresh, and a VM death matters more than a process crash.

### The four finding lines

- **CPU** — "99 % of tasks got a CPU within 30 µs (usually 29 µs). CPU utilization is 1 %." The first number is the run-queue latency p99 over the last 5 s: how long a task that was *ready to run* waited for a CPU. "Usually" is the median of the calm seconds in view. If there was a recent contention episode, a second sentence gives when, how long and the peak, and a third one names the cause ("stress-ng-cpu (32 processes) was using 93 % of total CPU") and the victims ("Other processes kept waiting: steam (437 ms total, 99 % within 989 µs)").
- **Memory** — whether any process is stalled right now in memory reclaim (a process that has to free memory itself before it can allocate), plus usage and free memory from `/proc`. If something stalled in the last 5 minutes, it says who and how much.
- **Processes** — the most recent OOM kill, crash loop or crash; otherwise the number of starts and how many processes lived under one second.
- **VM** — the most recent VM stop with its cause, or how many VMs are running.

### Recent incidents

One row per incident: level, kind, process/VM, time span (or *ongoing*), duration, and a detail that depends on the kind (peak wait, ms/s stalled, signal, OOM scope and trigger, crash count, who sent the signal). Ongoing incidents have no end time. Section 5 lists every kind.

### Status by resource (USE)

Three questions per resource, after Brendan Gregg's USE method:

| Column | Question | Example cells |
|---|---|---|
| **Utilization** | how busy is it | CPU %, memory %, process starts, VMs running |
| **Saturation** | is anything waiting for lack of it | CPU wait p99, ms/s stalled in reclaim, worst VM wait |
| **Errors** | did anything fail or get killed | OOM kills, crashes, VM stops |

Cells show the latest value, a 5-minute sparkline, and a level mark only when something is wrong. "Not implemented (roadmap n)" marks what is not built yet.

## 4. The screens

The menu (☰) has three groups: **eBPFLens** (Dashboard, All panels), **VMs** (VM list, then one entry per VM), **Host** (CPU wait, processes, memory; disk, network and GPU are planned).

### CPU wait (`/cpu`)

*What it is.* How long a runnable task waited for a CPU. On a calm 8-core box the 99th percentile is tens of microseconds; under 4× oversubscription it is 8–16 ms. Waiting here is invisible to CPU-utilization graphs: a host at 70 % can still make tasks wait milliseconds if the wrong ones are runnable at once.

*What you see.*
- **Wait time distribution** — a heatmap: x is time (last 5 min, one column per second), y is the wait (log scale, longer toward the top), colour is how often. Contention shows as the bright band jumping from the 8 µs row to the 8 ms row.
- **Wait time trend** — p50 and p99 with the caution (1 ms) and warning (10 ms) bands. While p99 is inside a band, processes are competing for CPU.
- **Cause and impact** — two tables for the latest episode (or the last 10 s): who *used* the CPU (share of the whole host) and who *waited* (total wait, count, p99, max). A "cause" is a process using ≥ 30 % of the host by itself; several neighbours at 25 % each are reported as victims only (a known gap, see §7).

*Reading it.* The process that waits most is the one users feel. A big consumer with a small wait is a hog; a small consumer with a big wait is a victim. Under EEVDF, tasks that sleep often (interactive ones) get preference when they wake, so victims usually wait an order of magnitude less than the hog — a 1 ms p99 for your latency-sensitive daemon during a 16 ms storm is what "protected but not immune" looks like.

### Processes (`/processes`)

*What it is.* Every exec, exit, OOM kill and terminating signal on the host, from the kernel, including processes that live for a millisecond. Command-line arguments are deliberately **not** recorded (they can contain passwords).

*What you see.* Four tiles (starts, exits under 1 s, error exits, crashes + OOM), a table of abnormal endings, the most frequent short-lived commands (cron and script noise, but also fork bombs), and the raw event log with an "abnormal only" filter.

*Reading it.* An **OOM kill** row tells you the scope (host out of memory vs. a cgroup limit) and *which process's allocation triggered it* — often not the victim. A **crash** is an exit by SIGSEGV/SIGABRT/SIGBUS/SIGFPE/SIGILL/SIGSYS or with a core dump; SIGTERM/SIGKILL are not crashes, they are someone stopping the process. A **signal** row says who sent SIGTERM/SIGKILL/SIGINT/SIGHUP/SIGQUIT to whom.

### Memory (`/memory`)

*What it is.* Time processes spend stalled in memory reclaim — the moment a process asks for memory and the kernel makes it wait while freeing some. Counted per process with eBPF (`direct reclaim` for a host-wide shortage, `memcg reclaim` for a cgroup limit). Usage and PSI come from `/proc` only to cross-check.

*What you see.* Tiles (stall ms/s, usage, available, PSI), a heatmap of stall lengths, a trend of eBPF stall vs. PSI, and the stalled processes with the cause (cgroup limit vs. host shortage).

*Reading it.* Usage alone is not a problem; stalling is. A process stalling under a **cgroup limit** is a container or VM at its own cap — the fix is its limit, not the host. Host-wide stalls mean the box is short. PSI reads lower than eBPF when only one process stalls while other CPUs stay busy; that is expected (PSI is weighted by CPU time), and the manual's rule of thumb is: trust the per-process number for *who*, PSI for *the machine as a whole*.

### VMs (`/vms` and `/vms/<name>`)

*What it is.* KVM guests seen from the host. eBPFLens recognises QEMU processes (libvirt and Proxmox naming), so each VM's CPU wait and reclaim stalls are filed under its name, and a VM's death is explained from host-side evidence. No agent inside the guest is needed for this; no libvirt access either.

*VM list.* One row per VM seen in the last 24 h: state (running since / stopped at · cause), host-side CPU wait p99, share of host CPU, reclaim stall, last incident. VMs with an active incident float to the top.

*VM page.* A **VM Lens Summary**:
- **Headline by cause** — *Killed by its cgroup memory limit*, *Killed by the host's OOM killer*, *QEMU crashed*, *Stopped by a signal*, *Exited cleanly*, or *Running*.
- **Evidence** — only facts that are present: who sent the signal, what allocation triggered the OOM and whether the limit was the VM's cgroup or the host, the signal and core dump, and the VM's last minute (reclaim stall, CPU wait p99).
- **Next step, with its reason** — e.g. *Raise the VM's memory limit or reduce guest memory; restarting alone will repeat this, because the limit is unchanged.*

Then the VM's own CPU-wait heatmap and trend (host side — this is steal time with a distribution), its reclaim stalls, and its incidents.

*Reading it.* A running VM whose wait p99 sits above 1 ms while its own CPU share is near zero is a **victim of noisy neighbours**: look at the host CPU screen for who is busy. A VM that stalled in reclaim before dying was thrashing against a limit — with swap on the host, a limit makes a VM crawl rather than die.

### All panels (`/all`)

Every panel from the screens above on one long page, with jump links. For when you want to scroll rather than click.

## 5. Incidents: what each kind means and what to do

Incidents are decided **on the server** by fixed rules (the thresholds are a JSON file, see §8). Levels never go down while an incident is open; the peak tells the story. An incident that was open when the server restarted is shown as closed at its last update — the server does not pretend to know what happened while it was down.

| Kind | Opens when | Level | Closes when | What it means / what to do |
|---|---|---|---|---|
| **CPU contention** (`cpu_wait`) | run-queue p99 ≥ 1 ms for 3 s | caution; warning once ≥ 10 ms for 3 s | p99 below 1 ms for more than 2 s | Tasks wait for CPUs. Open the CPU screen: the *cause* table names the hog; the *impact* table names who paid. Throttle or move the hog; do not add CPUs before knowing who eats them. |
| **Memory reclaim stall** (`mem_stall`) | ≥ 10 ms/s stalled for 3 s | caution; warning once ≥ 100 ms/s | below 10 ms/s for more than 2 s | Processes freeze while the kernel frees memory. The memory screen says who and whether it is a cgroup limit (fix the limit) or the host (free memory or add it). |
| **OOM kill** (`oom_kill`) | the kernel killed a process | warning | instant | Evidence: victim, trigger process, host vs. cgroup. If the trigger is not the victim, the trigger is where to look. |
| **Crash** (`crash`) | exit by a crash signal or with a core dump | caution | instant | A software fault. Check the process's own logs / core dump. |
| **Crash loop** (`crash_loop`) | the same command crashes 3 times in 5 min | warning | 5 min after the last crash | Something restarts it into the same failure. Stop the restart loop, then fix the crash. |
| **Agent stopped reporting** (`agent_down`) | no sample for 30 s | warning | the host reports again | The host, the network, or the agent is down — nothing else on this host is fresh. Check the host first. |
| **VM stopped** (`vm_down`) | a VM's QEMU process exited | warning for OOM / crash; caution for killed / clean exit | instant | Open the VM page: cause, evidence and next step are there. |

`vm_down` causes:

| Cause | Evidence | Next step (and why) |
|---|---|---|
| `cgroup_oom` | OOM kill inside the VM's own cgroup, with the triggering process | Raise the VM's memory limit or reduce guest memory; a restart alone repeats it because the limit is unchanged. |
| `host_oom` | OOM kill machine-wide | The host is overcommitted; free host memory before restarting or it may happen again. |
| `crash` | QEMU ended on a crash signal / core dump | Restart it; a QEMU crash is not the guest's fault — check the QEMU log and core dump. |
| `killed` | a terminating signal was sent to QEMU, with who sent it | If that was not intended, restart it. *libvirtd* as the sender covers both a guest shutdown and a `virsh destroy` (§7). |
| `shutdown` | exit 0 with no signal seen | A clean exit; restart if unintended. |

## 6. Notifications

`ebpflens-server -webhook URL` posts one line per **transition** — open, escalate, close — never progress updates. `-webhook-format generic` sends `{event, text, incident}`; `slack` sends `{text}`; `discord` sends `{content}`. Lines look like:

```
[WARNING] hal: processes are competing for CPU (99% of tasks waited up to 16.3 ms, 3 s since 09:01:34)
[RESOLVED] hal: processes are competing for CPU (99% of tasks waited up to 16.3 ms, 21 s since 09:01:34)
[WARNING] hal: flaky-app is crashing repeatedly (3 times since 09:02:00)
[WARNING] hal: host stopped reporting (last sample at 09:02:09, silent for 30 s)
[WARNING] hal: VM web-02 stopped at 09:55:38: its cgroup memory limit was reached; triggered by libvirtd (pid 2002). In the minute before: 1188 ms stalled in memory reclaim, CPU wait p99 29 µs
```

Delivery is asynchronous with one retry; a dead webhook never blocks the agents.

## 7. What eBPFLens cannot see, and other limits

- **No authentication.** Anyone who can reach the server can read everything and post fake samples. Run it on a trusted network only.
- **A guest shutdown and a `virsh destroy` look the same from the host.** libvirt runs QEMU with `-no-shutdown` and sends SIGTERM itself in both cases, and QEMU exits 0 on SIGTERM. Telling them apart needs libvirt's own stop reason, which is not read yet.
- **Culprit needs a single process ≥ 30 %.** Three neighbours at 25 % each are reported as victims only.
- **Per-process tables are top-N.** The agent sends the top 8 by wait and by CPU each second (VMs always). Totals over long ranges are therefore approximate; the screens say so.
- **A host-wide OOM of a VM** has been reproduced only in unit tests on recorded event shapes, not live.
- **Thresholds are provisional**, chosen from one 8-core machine. Tune them (§8) to your hosts.
- **Linux only.** macOS has no eBPF; a best-effort macOS agent is planned, not built.
- **Windows is not planned** unless there is demand.
- **The dashboard shows the last 5 minutes of samples and 24 hours of incidents.** The DB keeps samples 24 h, events 7 days, incidents 30 days; there is no long-range history screen yet.

## 8. Configuration and API quick reference

Server:

| Flag | Default | Meaning |
|---|---|---|
| `-addr` | `:8080` | listen address |
| `-db` | (none) | SQLite file; empty disables persistence |
| `-keep` | 900 | samples kept in memory per host × probe (the UI window) |
| `-keep-events` | 20000 | events kept in memory per host |
| `-retention` / `-event-retention` / `-incident-retention` | 24h / 168h / 720h | DB retention |
| `-triggers` | (defaults) | JSON file over the default thresholds; `-print-triggers` prints them |
| `-webhook` / `-webhook-format` | (none) / `generic` | notifications |

Agent: `-server URL`, `-host NAME`, `-interval 1s`, `-top 8`, `-text` (human-readable output), `-count N`.

Trigger file (values shown are the defaults):

```json
{
  "cpu":       {"caution": 1000, "warning": 10000, "minSeconds": 3, "maxGapSeconds": 2},
  "memory":    {"caution": 10,   "warning": 100,   "minSeconds": 3, "maxGapSeconds": 2},
  "processes": {"crashLoopCount": 3, "crashLoopWindowSeconds": 300},
  "agentDown": {"afterSeconds": 30}
}
```

API (all `GET` unless noted): `/api/hosts`, `/api/samples?host=&probe=runqlat|memstall|vms`, `/api/events?host=`, `/api/incidents?host=` (newest first; ongoing ones have no `end`), `/api/triggers`, `/api/stream?host=` (SSE: `sample`, `events`, `incident`); agents `POST /api/ingest` and `/api/events`.

## 9. Glossary

- **Run-queue latency (CPU wait)** — time between a task becoming runnable and actually running on a CPU. The saturation signal for CPUs.
- **p50 / p99** — the value half / 99 % of measurements stay under. p99 is what the unlucky requests see.
- **Reclaim stall** — a process paused while the kernel frees memory on its behalf (direct or cgroup reclaim).
- **PSI** — the kernel's Pressure Stall Information (`/proc/pressure/*`): machine-wide productive time lost; lower than per-process stall when only one process stalls.
- **OOM kill** — the kernel killing a process for lack of memory, machine-wide or inside a cgroup.
- **cgroup** — the kernel's resource-limit grouping; containers and VMs each live in one.
- **Steal** — CPU time a VM wanted but the host gave to someone else; eBPFLens shows it as the VM's host-side run-queue wait.
- **Incident** — one thing the rules judged wrong, with its evidence, start, end and level.
