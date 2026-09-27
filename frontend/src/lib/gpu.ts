// Turns gpu samples (NVML for the GPU itself, libcuda uprobes per process) into what they mean for an operator:
// how busy the GPU is, and for each CUDA process a verdict on where its time goes. Whether that is "bad" is
// judged by the server (gpu_starved / vram_full incidents); this file only summarizes values.
import type { GPUProc, GPUStat, Sample } from "../types/model";
import type { Level } from "./lens";
import { translate, type Key, type Lang, type Params } from "./i18n";
import { formatBytes } from "./memory";

export const GPU_KINDS = ["gpu_starved", "vram_full"] as const;

const CURRENT_WINDOW = 5; // current values are averaged over the last 5 s (GPU work is bursty)

export const gpuUtil = (s: Sample) => (s.gpu ? s.gpu.util : null);
export const vramUsed = (s: Sample) => (s.gpu && s.gpu.totalBytes ? s.gpu.usedBytes / s.gpu.totalBytes : null);

// The GPU right now: utilization averaged over the last 5 s, the latest VRAM / temperature / power
export function currentGpu(samples: Sample[]): { gpu?: GPUStat; util: number | null; vram: number | null } {
  const last = samples.at(-1)?.gpu;
  const xs = samples.slice(-CURRENT_WINDOW).map(gpuUtil).filter((v): v is number => v != null);
  const util = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  return { gpu: last, util, vram: last ? vramUsed(samples.at(-1)!) : null };
}

// Where a CUDA process's time went, judged per second from the uprobe counters and the GPU's utilization:
//   busy     the GPU is working (util >= 80 %); waiting inside synchronize is expected, the GPU is the bottleneck
//   copy     the process spends its time inside copy calls (pageable memory, small batches): the GPU waits for transfers
//   mixed    the GPU is busy part of the time and the process is on the CPU the rest: the CPU side is the next limit
//   cpu      the GPU is idle and the process is computing on the CPU (preprocessing, tokenizing, Python overhead)
//   waiting  the GPU is idle and the process is neither on the CPU nor in a CUDA call: I/O, a lock, or its input
//   idle     the process holds VRAM but did nothing this second (a loaded model with no requests)
export type Verdict = "busy" | "copy" | "mixed" | "cpu" | "waiting" | "idle";

const BUSY_UTIL = 0.8;

export function verdict(p: GPUProc, util: number, intervalMs: number, idleUtil: number): Verdict {
  const interval = intervalMs * 1e6;
  const cpu = p.onCpuNs / interval;
  const copy = p.copyNs / interval;
  const active = p.launches + p.copyCount + p.syncCount > 0;
  if (util >= BUSY_UTIL) return "busy";
  if (!active && cpu < 0.05) return "idle";
  if (copy >= 0.3) return "copy";
  if (cpu >= 0.5) return util >= idleUtil ? "mixed" : "cpu";
  if (util >= idleUtil) return "busy";
  return "waiting";
}

export type GpuProcRow = {
  comm: string;
  procs: number;
  vramBytes: number; // latest
  launchesPerSec: number;
  h2dBytesPerSec: number;
  d2hBytesPerSec: number;
  copyShare: number; // share of the time inside copy calls
  syncShare: number; // share of the time waiting for the GPU
  cpuShare: number; // share of one CPU
  seconds: number; // samples the process appeared in
  verdict: Verdict; // the most common verdict over the window
};

// Per-process rows over the visible range (per name, most active first). Rates are per second of the window
// the process was present in, so a process that ran for 10 s of a 5-minute window is not diluted to nothing
export function gpuProcs(samples: Sample[], idleUtil: number): GpuProcRow[] {
  const acc = new Map<string, GpuProcRow & { ns: number; verdicts: Record<Verdict, number> }>();
  for (const s of samples) {
    if (!s.gpu || !s.intervalMs) continue;
    for (const p of s.gpu.procs ?? []) {
      let a = acc.get(p.comm);
      if (!a) {
        a = {
          comm: p.comm, procs: 0, vramBytes: 0, launchesPerSec: 0, h2dBytesPerSec: 0, d2hBytesPerSec: 0,
          copyShare: 0, syncShare: 0, cpuShare: 0, seconds: 0, verdict: "idle", ns: 0,
          verdicts: { busy: 0, copy: 0, mixed: 0, cpu: 0, waiting: 0, idle: 0 },
        };
        acc.set(p.comm, a);
      }
      a.procs = Math.max(a.procs, p.procs);
      a.vramBytes = p.vramBytes;
      a.launchesPerSec += p.launches;
      a.h2dBytesPerSec += p.h2dBytes;
      a.d2hBytesPerSec += p.d2hBytes;
      a.copyShare += p.copyNs;
      a.syncShare += p.syncNs;
      a.cpuShare += p.onCpuNs;
      a.ns += s.intervalMs * 1e6;
      a.seconds++;
      a.verdicts[verdict(p, s.gpu.util, s.intervalMs, idleUtil)]++;
    }
  }
  return [...acc.values()]
    .map((a) => {
      const sec = a.ns / 1e9;
      const verdicts = Object.entries(a.verdicts) as [Verdict, number][];
      const top = verdicts.reduce((x, y) => (y[1] > x[1] ? y : x))[0];
      return {
        comm: a.comm, procs: a.procs, vramBytes: a.vramBytes, seconds: a.seconds,
        launchesPerSec: a.launchesPerSec / sec, h2dBytesPerSec: a.h2dBytesPerSec / sec, d2hBytesPerSec: a.d2hBytesPerSec / sec,
        copyShare: a.copyShare / a.ns, syncShare: a.syncShare / a.ns, cpuShare: a.cpuShare / a.ns, verdict: top,
      };
    })
    .sort((x, y) => y.launchesPerSec + y.h2dBytesPerSec / 1e6 - (x.launchesPerSec + x.h2dBytesPerSec / 1e6));
}

export const VERDICT_KEY: Record<Verdict, Key> = {
  busy: "gpu.verdict.busy",
  copy: "gpu.verdict.copy",
  mixed: "gpu.verdict.mixed",
  cpu: "gpu.verdict.cpu",
  waiting: "gpu.verdict.waiting",
  idle: "gpu.verdict.idle",
};

export const pct = (v: number | null | undefined) => (v == null ? "–" : `${Math.round(v * 100)}%`);
export const formatRate = (bytesPerSec: number) =>
  bytesPerSec < 1e6 ? `${Math.round(bytesPerSec / 1e3)} kB/s` : bytesPerSec < 1e9 ? `${(bytesPerSec / 1e6).toFixed(0)} MB/s` : `${(bytesPerSec / 1e9).toFixed(2)} GB/s`;

// One-line sentence for the summary. `level` is the GPU area's level from the server's incidents
export function gpuSentence(samples: Sample[], lang: Lang, level: Level, idleUtil: number): string {
  const tr = (k: Key, p?: Params) => translate(lang, k, p);
  const now = currentGpu(samples);
  if (!now.gpu) return tr("gpu.summary.none");
  const state = tr("gpu.summary.state", {
    util: pct(now.util), vram: pct(now.vram), used: formatBytes(now.gpu.usedBytes), total: formatBytes(now.gpu.totalBytes),
  });
  const rows = gpuProcs(samples.slice(-CURRENT_WINDOW), idleUtil);
  const top = rows[0];
  if (!top) return `${state} ${tr("gpu.summary.noProcs")}`;
  const who = top.procs > 1 ? tr("cause.who", { comm: top.comm, n: top.procs }) : top.comm;
  const what = tr(VERDICT_SENTENCE[top.verdict], {
    comm: who, util: pct(now.util), cpu: pct(top.cpuShare), copy: pct(top.copyShare), sync: pct(top.syncShare), vram: formatBytes(top.vramBytes),
  });
  const throttle = now.gpu.throttle?.length ? ` ${tr("gpu.summary.throttle", { why: now.gpu.throttle.map((x) => tr(throttleKey(x))).join(tr("list.sep")) })}` : "";
  return level !== "ok" ? `${what} ${state}${throttle}` : `${state} ${what}${throttle}`;
}

const VERDICT_SENTENCE: Record<Verdict, Key> = {
  busy: "gpu.summary.busy",
  copy: "gpu.summary.copy",
  mixed: "gpu.summary.mixed",
  cpu: "gpu.summary.cpu",
  waiting: "gpu.summary.waiting",
  idle: "gpu.summary.idle",
};

export function throttleKey(reason: string): Key {
  switch (reason) {
    case "power": return "gpu.throttle.power";
    case "thermal": return "gpu.throttle.thermal";
    case "hw": return "gpu.throttle.hw";
    default: return "gpu.throttle.other";
  }
}
