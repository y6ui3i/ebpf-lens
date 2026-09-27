# eBPFLens

[日本語](README.ja.md)

An experiment in reinventing a Zabbix-style Linux dashboard with eBPF.

**Design goal: someone who has never heard of eBPF should still be able to tell what is happening on a Linux box right now.**
eBPFLens uses eBPF to capture what polling-based averages hide — latency distributions, per-process cause and impact, and events such as process launches and OOM kills — and turns them into *meaning for the operator* rather than raw data. The top of the screen shows a verdict and a plain-language summary (the Lens Summary); heatmaps and tables sit below as the evidence.

> Status: experimental. Built and tested on one machine (Ubuntu 26.04, kernel 7.0). There is no authentication yet — run it only on a trusted network.

## Architecture

```
[each host]                    [server]                      [browser]
ebpflens-agent (Go)  ──JSON──▶ ebpflens-server (Go)  ──SSE/API──▶ UI (React + TS)
 eBPF probes (+ /proc)          storage, API                   embedded in the server
```

- **Agent**: Go + [cilium/ebpf](https://github.com/cilium/ebpf) (CO-RE). A monitored host only needs kernel BTF; the agent ships as a single binary.
  - `runqlat`: CPU run-queue latency histogram, plus per-process CPU time and run-queue wait
  - `proclife`: exec / exit / OOM-kill events via a ring buffer. Command-line arguments are deliberately **not** captured because they can contain passwords.
  - `memstall`: per-process time stalled in memory reclaim (`mm_vmscan_direct_reclaim_*` / `mm_vmscan_memcg_reclaim_*`). `/proc/meminfo` and `/proc/pressure/memory` are read only to cross-check.
- **Server**: Go. Keeps the recent window for the UI in memory (last 900 samples per host × probe, last 20,000 events per host) and persists to SQLite.
- **UI**: React + Vite + TypeScript SPA with TanStack Query, Tailwind and uPlot; heatmaps are drawn on a canvas. TypeScript types are generated from the Go model with tygo.
- **Concepts**: borrowed from Zabbix — hosts, items, triggers, events.

## Design decisions

- [ADR 0001: Everyone an SRE — explain incidents so that whoever is on call can act](docs/adr/0001-everyone-an-sre.md)
- [ADR 0002: One agent binary, collectors split per OS](docs/adr/0002-collectors-per-os.md)

## Screen design principles

- **The dashboard (`/`) is an overview of every resource.** The Lens Summary and a USE-method grid (resource × utilization / saturation / errors) fit on one screen and never grow vertically. A new probe fills in cells of the grid.
- **Per-resource pages hold the details.** A new probe adds one page under "Resources" in the menu (e.g. `/cpu`, `/processes`, `/memory`).
- **All panels (`/all`) shows everything at once.** It stacks the panels from every per-resource page. A new probe adds its panel here too.
- Meaning before raw data: the verdict and the summary come first, charts are the evidence.

## Build and run

Build the Go binaries on the same kind of Linux you monitor (`vmlinux.h` is generated from the running kernel's BTF). Build the UI on any machine with Node; the output in `internal/webui/dist` is embedded into the server.

Requirements: Go 1.25+, clang, llvm, libbpf-dev, bpftool (and Node for the UI).

```bash
make web      # generate TS types + build the UI (on a machine with Node)
make build    # agent and server (on Linux)

./bin/ebpflens-server -addr :8080 -db ./ebpflens.db
sudo ./bin/ebpflens-agent -server http://127.0.0.1:8080
```

The agent also runs standalone:

```bash
sudo ./bin/ebpflens-agent            # JSON Lines every second
sudo ./bin/ebpflens-agent -text      # runqlat-style text histograms
```

`slots[i]` is the count in `[2^i, 2^(i+1))` microseconds for that interval.

UI development: `cd frontend && EBPFLENS_API=http://<server>:8080 npm run dev`.

## Running as a service (systemd)

Units live in `deploy/systemd/`.

- **The agent does not run as root.** It runs as the dedicated `ebpflens` user with only `CAP_BPF` and `CAP_PERFMON`, which are enough to attach to tracepoints / fentry and read ring buffers.
- The server has no privileges and can write only to its state directory (`ProtectSystem=strict`).
- The services never run the development `bin/`. `make install` copies binaries to `/opt/ebpflens/bin`, then restart the services.

First time:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin ebpflens
sudo usermod -aG ebpflens "$USER"            # to read the DB with sqlite3
make install
sudo systemctl enable --now ebpflens-server ebpflens-agent
```

Update:

```bash
make install
sudo systemctl restart ebpflens-server ebpflens-agent
```

The DB goes to `/var/lib/ebpflens/ebpflens.db` (systemd `StateDirectory`). To keep it elsewhere, add a drop-in:

```ini
# /etc/systemd/system/ebpflens-server.service.d/10-local-db.conf
[Unit]
RequiresMountsFor=/mnt/data/ebpflens

[Service]
ExecStart=
ExecStart=/opt/ebpflens/bin/ebpflens-server -addr :8080 -db /mnt/data/ebpflens/ebpflens.db
ReadWritePaths=/mnt/data/ebpflens
```

## Triggers and notifications

The judgement runs on the server (`internal/trigger`), not in the browser, so incidents exist whether or not anyone is watching. Every rule is deterministic and every incident carries the numbers that caused it (see [ADR 0001](docs/adr/0001-everyone-an-sre.md)).

| Kind | Opens when | Level | Closes when |
|---|---|---|---|
| `cpu_wait` | run-queue p99 ≥ 1 ms for 3 s | caution; warning once ≥ 10 ms for 3 s | below 1 ms for more than 2 s |
| `mem_stall` | reclaim stall ≥ 10 ms/s for 3 s | caution; warning once ≥ 100 ms/s for 3 s | below 10 ms/s for more than 2 s |
| `oom_kill` | an OOM kill event | warning | instant (records the trigger process and cgroup vs. host) |
| `crash` | exit by SIGSEGV / SIGABRT / SIGBUS / SIGFPE / SIGILL / SIGSYS or with a core dump | caution | instant |
| `crash_loop` | the same command crashes 3 times within 5 minutes | warning | 5 minutes after the last crash |
| `agent_down` | a host sends nothing for 30 s | warning | the host reports again |

A level never goes down while an incident is open; the peak tells the story. Incidents are stored in SQLite (`incidents` table, upserted by id, kept 30 days with `-incident-retention`), streamed over SSE as `event: incident`, and listed at `GET /api/incidents?host=`. An incident that was still open when the server stopped is restored as closed at its last update: the rule state that kept it open did not survive, and a stale "ongoing" would be a lie.

Thresholds are a JSON file over the defaults (`-print-triggers` shows them; a file only needs the values it changes), served at `GET /api/triggers` so the UI draws its bands from the same numbers:

```bash
./bin/ebpflens-server -print-triggers > triggers.json   # edit, then
./bin/ebpflens-server -db … -triggers triggers.json
```

`-webhook URL` posts each transition (open, escalate, close — not progress updates) as JSON; `-webhook-format slack` or `discord` sends just the one-line text those services expect, e.g.

```
[WARNING] hal: processes are competing for CPU (99% of tasks waited up to 16.3 ms, 3 s since 09:01:34)
[RESOLVED] hal: processes are competing for CPU (99% of tasks waited up to 16.3 ms, 21 s since 09:01:34)
[WARNING] hal: flaky-app is crashing repeatedly (3 times since 09:02:00)
[WARNING] hal: host stopped reporting (last sample at 09:02:09, silent for 30 s)
```

Delivery is asynchronous with one retry; a dead webhook never blocks ingestion.

## Why did this VM stop?

On a KVM host the agent recognises QEMU processes from `/proc` (comm `qemu-system-*`, name from `-name guest=…` as libvirt passes it, or `-name …` as Proxmox does; no libvirt dependency), files their CPU wait and reclaim stalls under `vm:<name>`, tags their events, and sends the list of running VMs once a second (`probe=vms`). When a VM's QEMU exits, the server raises a `vm_down` incident whose cause comes from the evidence at hand, in this order:

| Evidence | Cause | Level |
|---|---|---|
| an OOM kill of that pid just before, inside the VM's cgroup | `cgroup_oom` (with the process that asked for memory) | warning |
| an OOM kill of that pid just before, machine-wide | `host_oom` (with the trigger process) | warning |
| exit by a crash signal or with a core dump | `crash` | warning |
| a terminating signal sent to that pid just before, or a signal exit | `killed` (with who sent it) | caution |
| none of the above: exit 0 | `shutdown` | caution |

The incident also carries what the VM went through in the minute before: time stalled in memory reclaim and its run-queue wait p99, both from the per-process eBPF stats (in the lab's cgroup OOM: 1,188 ms stalled in reclaim, 929 ms of it in the final second).

Two things the lab taught us, both now handled:

- **QEMU handles SIGTERM and exits 0**, so the exit alone cannot show that anyone killed it. The `signal_generate` tracepoint records who sent SIGTERM / SIGKILL / SIGINT / SIGHUP / SIGQUIT to which process (only signals that were actually queued, never a process signalling itself). That is what turns "exit 0" into "stopped by libvirtd (pid 2002)". Volume is negligible: about ten such signals in ten minutes on the test host, mostly udev reaping its workers.
- **libvirt runs QEMU with `-no-shutdown`** and sends SIGTERM itself after the guest halts, so a `virsh shutdown` and a `virsh destroy` end identically from the host's point of view. The text says so ("a managed shutdown or a virsh destroy"); telling them apart needs libvirt's own stop reason, which is a later step.

Reproduced on the test host with the lab VM: `virsh destroy` → killed by libvirtd (SIGTERM); `virsh shutdown` → the same, as explained; `kill -SEGV` on QEMU → crash; `virsh memtune --hard-limit 256M` plus a 700 MB allocation inside the guest → `cgroup_oom`, matching the kernel's "Memory cgroup out of memory: Killed process … (qemu-system-x86)". A host-wide OOM of a VM cannot be triggered safely on the test host; the rule is covered by unit tests against the recorded event shapes.

## Storage

With `-db`, samples and events are stored in SQLite (pure-Go modernc.org/sqlite, no cgo). History survives restarts.

- Retention: samples 24 hours (`-retention`), events 7 days (`-event-retention`). Old rows are deleted every 10 minutes.
- Writes are queued and committed once per second in a single transaction, so ingestion never blocks on the DB.
- Rough size on the test machine: about 4 KB per sample (about 350 MB per day per host); events about 0.7 per second when idle.
- **Keep the DB file on a local disk.** SQLite file locking is not reliable over NFS and the database can be corrupted.

### Moving to PostgreSQL when it grows

Move to PostgreSQL when any of these is true, and add TimescaleDB if it still struggles (the same path Zabbix itself takes):

- more than 10 monitored hosts
- per-second data needs to be kept longer than a week
- cross-host aggregation is needed

To keep that move cheap, the SQL is limited to what both engines accept (Unix-millisecond integers for time, JSON text for bodies, `ON CONFLICT`). Storage sits behind the `Persister` interface in `internal/store`, so only that package changes. Prometheus-style TSDBs are not a good fit: they cannot hold events such as process exits, and per-process histograms explode the series count.

## Roadmap

Policy: **eBPF is the primary source for everything except the GPU.** `/proc` and PSI are for cross-checking.

1. ✅ runqlat in Go, histograms as JSON
2. ✅ Server + UI: run-queue latency heatmap, threshold bands, Lens Summary, recent incidents
3. ✅ Cause and impact: per-process run-queue wait (who waited) and CPU time (who used the CPU)
4. ✅ Process lifecycle: exec / exit (exit code, signal, lifetime) / OOM kill; CPU utilization from eBPF measurements
5. ✅ Layout: overview page (Lens Summary + USE grid) and per-resource pages, responsive menu
6. ✅ Memory pressure: per-process time stalled in reclaim (direct and memcg), cross-checked with PSI and `/proc/meminfo`
7. ✅ Triggers and notifications: verdicts run on the server as incidents, with a webhook; all inputs come from eBPF
8. 🔶 VM monitoring (first step done: why a VM stopped; VM screens next): watch KVM guests from the host — vCPU run-queue wait (steal time with a cause), QEMU memory stalls, why a VM died (host OOM, QEMU crash, guest panic / shutdown via KVM tracepoints), correlated with an agent inside the guest. VMs get their own screens: the menu becomes **Host** (today's resources) and **VMs** (a list, then one page per VM with its own Lens Summary), because people who run VMs come to ask about *their* VM, not the server
9. GPU basics (NVML — the one exception that is not eBPF): utilization, VRAM, temperature, power, per-process VRAM
10. GPU × eBPF: uprobes on libcudart / libcuda to measure kernel launches, transfers and sync waits per inference process, and explain *why the GPU is idle*
11. Disk and network: biolatency / tcpconnect / tcpretrans
12. macOS agent: same server, same UI, same incidents, fed by what macOS exposes without special entitlements (CPU and load, memory pressure level, process exec/exit via kqueue, per-process CPU via libproc). macOS has no eBPF, so run-queue latency distributions and per-process reclaim stalls are out of reach there — the Mac agent is best effort, not the main line. Collectors are split per OS (see [ADR 0002](docs/adr/0002-collectors-per-os.md)). Windows only if there is demand (it would be ETW)

## Thresholds (provisional)

CPU run-queue latency p99: caution at 1 ms, warning at 10 ms; an excursion that lasts 3 seconds or more becomes an incident (see Triggers above).

Measured on the test machine (2026-09-26):

| State | median of per-second p99 | max of per-second p99 |
|---|---|---|
| idle | 29 µs | 167 µs |
| Demucs (PyTorch GPU inference, GPU 76% on average) | 27 µs | 476 µs |
| stress-ng, 4× CPU oversubscription | 16 ms | 30 ms |

GPU inference hardly creates CPU contention. Training (DataLoader workers filling the CPUs) has not been measured.

Per process (4× oversubscription with stress-ng, plus a `victim-app` that wakes every 1 ms):

| Process | idle p99 | overloaded p99 | CPU |
|---|---|---|---|
| stress-ng-cpu ×32 | – | 16 ms | 99.5% |
| victim-app | 16 µs | 1.0 ms | 0.1% |

EEVDF favors tasks that sleep often when they wake up, so the bystander waits an order of magnitude less than the CPU hog.

Memory reclaim stall (sum over all processes): caution at 10 ms/s, warning at 100 ms/s.

## Reclaim stall vs. PSI

`memstall` adds up the time each thread actually spent stalled in reclaim. PSI (`some` in `/proc/pressure/memory`) weights each CPU's stall time by that CPU's non-idle time and averages them — "productive time lost by the machine" — and is aggregated roughly every 2 seconds. When a single process stalls while other CPUs keep working, PSI comes out smaller.

- Test machine (four `dd` processes, each reading its own file inside a 32 MB cgroup): eBPF about 11.5 ms/s, PSI some about 3–5 ms/s.
- Test VM (1 GB, 2 vCPUs, memory exhausted): over 5 seconds eBPF 127.8 ms and PSI some 134.7 ms — almost equal, because with few CPUs and nearly everyone stalled there is nothing to dilute the average. Besides the `python3` that was allocating, `systemd-journal`, `rsyslogd` and the agent itself (up to 9 ms) stalled too. It ended with an OOM kill (`memcg=false`, all 244,727 pages of the VM).

## Test VM

A machine-wide memory shortage (direct reclaim) or a global OOM cannot be triggered from a container: hitting a cgroup limit only causes memcg reclaim, while direct reclaim happens when free memory of the whole machine drops below the watermark. A small libvirt / KVM VM lets you trigger it without disturbing the host.

```bash
sh lab/create-vm.sh          # create and start (or just start). Ubuntu 26.04 cloud image, 1 GB RAM, no swap
sh lab/create-vm.sh push     # copy bin/ebpflens-agent into the VM
sh lab/create-vm.sh ssh      # log in
virsh -c qemu:///system shutdown ebpflens-lab   # stop (the disk is kept)
```

VM files go to `/var/lib/libvirt/images/ebpflens-lab` unless `LAB_DIR` is set. The VM ran kernel 7.0.0-31 while the host ran 7.0.0-34, and the agent built on the host ran unchanged in the VM (CO-RE).

## Test machine

- Ubuntu 26.04.1, kernel 7.0.0-34-generic, 8 cores, 30 GB RAM, RTX 2070

## Further reading

- Blog post (Japanese): [平均値の裏を覗く — eBPFとは何か、Zabbixと比べて何が見えるのか](https://pocraft.net/2026/09/26/ebpf-intro-vs-zabbix/)

## License

[Apache License 2.0](LICENSE). The BPF programs under `internal/probe/*/*.bpf.c` are dual-licensed BSD/GPL, as required to use GPL-only kernel helpers.
