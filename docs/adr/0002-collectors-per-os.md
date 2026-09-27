# ADR 0002: One agent binary, collectors split per OS

- Status: Accepted
- Date: 2026-09-27

## Context

eBPFLens started as a Linux-only project: every signal comes from eBPF, and `internal/probe/*` is eBPF C plus its Go loader. The roadmap now adds a macOS agent (item 12) and leaves the door open for Windows. Neither OS has eBPF. macOS exposes CPU and load (`host_statistics`), a memory pressure level (`kern.memorystatus_level`), process exec/exit (kqueue `EVFILT_PROC`) and per-process CPU time (`libproc`) without special entitlements; it does not expose run-queue latency distributions or per-process reclaim stalls at all. Windows would be ETW.

The server, the UI, the incident rules and the shared model do not care where a sample came from. What differs per OS is only how a sample is produced.

## Decision

- **One agent binary per OS, built from the same `cmd/ebpflens-agent`.** Which collectors exist is decided at build time by Go build constraints, not at run time.
- **Collectors live in one directory per OS**: `internal/collector/linux` (the current eBPF probes move here), `internal/collector/darwin`, and later `internal/collector/windows`. `internal/collector` holds the shared interface: something that, once opened, yields `model.Sample`s and `model.ProcEvent`s on a schedule. The agent main only wires the collectors for the OS it was built for.
- **The model is shared and stays honest.** A probe a platform cannot provide is simply absent from that host's samples; the UI shows "not available on this platform" for that cell rather than a zero. The `HostInfo.Probes` list already carries what a host provides.
- **eBPF stays the main line.** Roadmap items are designed for Linux first; the macOS collector is best effort and is documented as such. The project keeps its name.

## Consequences

- Moving `internal/probe/*` under `internal/collector/linux` is a mechanical rename done in the first PR that touches the agent layout (before the macOS work), so history stays readable.
- `make build` on macOS produces a working agent for the first time; the Makefile gains per-OS targets and the BPF generation step becomes Linux-only.
- The dashboard and the USE grid need a "not available on this platform" cell state (distinct from "not implemented yet").
- Cross-checking against `/proc` becomes cross-checking against whatever the OS offers; on macOS there may be nothing to cross-check some signals against, and the UI must not pretend otherwise.
