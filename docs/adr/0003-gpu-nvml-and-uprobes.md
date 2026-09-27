# ADR 0003: The GPU is watched with NVML for the device and uprobes on libcuda for the processes

Status: Accepted (2026-09-27)

## Context

eBPFLens's rule is "eBPF is the primary source for everything" (README, ADR 0001). The GPU breaks it: the
kernel does not know what the GPU is doing. Utilization, VRAM, temperature and power live in the NVIDIA driver
and are only reachable through its management library (NVML, the same source as `nvidia-smi`). There is no
tracepoint for "a kernel is running on the GPU".

The question an operator of an inference box asks is not "how busy is the GPU" (nvidia-smi answers that) but
**"why is it idle"** — a model that should be saturating the GPU is at 30 % and nobody can tell whether the
bottleneck is preprocessing on the CPU, host↔GPU copies, or the process waiting for input.

Choices for the per-process half:

1. **NVML per-process utilization** (`nvmlDeviceGetProcessUtilization`): not supported on GeForce cards
   (returns Not Found on the RTX 2070); and it only says how much, not why.
2. **CUPTI / Nsight**: the right tool for a developer, but it must be linked into or attached to the
   application, changes its timing, and is not something to leave running on a production host.
3. **uprobes on libcuda**: every CUDA program — PyTorch, llama.cpp, TensorRT, hand-written — ends up in the
   driver API in `libcuda.so.1`. A uprobe on `cuLaunchKernel` counts work handed to the GPU; uprobe +
   uretprobe on `cuMemcpy*Async` measure bytes and the time the call blocked (a copy from pageable memory
   blocks inside the call); the same on `cuStreamSynchronize` / `cuCtxSynchronize` / `cuEventSynchronize`
   measure time spent waiting for the GPU. Nothing is linked into the application, and a container process
   is seen too because the NVIDIA container toolkit bind-mounts the host's `libcuda.so.1` (same inode).

## Decision

- **NVML for the device** (`internal/probe/gpu/nvml.go`, via the official `go-nvml` binding, opened with
  `dlopen` at run time so the agent builds and runs on hosts without a GPU). It is the **one source in
  eBPFLens that is not eBPF**, and it is limited to what only the driver knows: utilization, VRAM, temperature,
  power, clock throttling, and which pid holds how much VRAM.
- **uprobes on libcuda for the processes** (`internal/probe/gpu/gpu.bpf.c`). Per process: kernel launches,
  bytes copied in each direction, time inside copy calls, time inside synchronize calls. The agent joins
  each process's CPU time from runqlat, so one sample says whether a process was on the GPU, copying,
  on the CPU, or none of these.
- **The verdict is a fixed rule**, per process and second, in the order: GPU busy enough → *GPU-bound*;
  else time in copies ≥ 30 % → *transfer-bound*; else CPU ≥ 50 % of a core → *CPU-bound*; else no CUDA call
  and no CPU → *idle*; else *waiting elsewhere* (I/O, a lock, input). The server's `gpu_starved` rule is the
  same idea over 10 s: the GPU below 20 % busy while a process is ≥ 50 % busy on the CPU or in copies.
- **go-nvml is the project's second "new technology" slot** (the first is cilium/ebpf). It is the official
  binding, pinned, and it brings cgo into the agent build; the alternative of parsing `nvidia-smi` output
  every second was rejected as slower (~100 ms per call) and less precise.

## Consequences

- A host without an NVIDIA driver sends no `gpu` samples and the UI shows no GPU row; nothing else changes.
- Only the first GPU is watched. Multi-GPU hosts are a later step.
- The uprobes cost one BPF program entry per CUDA call. On the test host an OCR job makes about 7,000
  launches and 1,000 copy/sync calls per second; with them attached the agent used about 2 % of a core and
  46 MB RSS (it was 0.3 % and 23 MB before the GPU probe; most of the difference is NVML, polled once a second).
- The uprobes are attached as multi-uprobe BPF links (kernel 6.6+). Ubuntu ships `kernel.perf_event_paranoid=4`,
  which refuses the classic perf_event uprobe to anyone without CAP_SYS_ADMIN; the BPF link needs only
  CAP_PERFMON, which the agent already has. There is no fallback to the perf_event path.
- Per-process GPU utilization is still not known on GeForce; the verdict reasons from the process's side
  (what it was doing) and the device's side (how busy it was), which is what the operator needs to act.
