// Turns pgfault samples (page faults per process, major faults timed, swap state) into what they mean for an
// operator. Whether it is "bad" is judged by the server (fault_stall); this file only summarizes.
import type { Sample } from "../types/model";
import type { Level } from "./lens";
import { formatBytes, formatMsPerSec } from "./memory";
import { translate, type Key, type Lang, type Params } from "./i18n";

export const FAULT_KINDS = ["fault_stall"] as const;

const CURRENT_WINDOW = 5;

// Time stalled in major faults, ms per second of wall time
export const faultStallMsPerSec = (s: Sample) => (s.faults && s.intervalMs ? s.faults.majorNs / 1e6 / (s.intervalMs / 1000) : null);
export const majorPerSec = (s: Sample) => (s.faults && s.intervalMs ? s.faults.major / (s.intervalMs / 1000) : null);
export const swapUsed = (s: Sample) => (s.faults && s.faults.swapTotalBytes ? s.faults.swapUsedBytes / s.faults.swapTotalBytes : null);

export function currentFaults(samples: Sample[]) {
  const last = samples.slice(-CURRENT_WINDOW);
  const mean = (f: (s: Sample) => number | null) => {
    const xs = last.map(f).filter((v): v is number => v != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const f = samples.at(-1)?.faults;
  const sum = (g: (x: NonNullable<Sample["faults"]>) => number) => samples.reduce((a, s) => a + (s.faults ? g(s.faults) : 0), 0);
  return {
    stall: mean(faultStallMsPerSec), majorPerSec: mean(majorPerSec), faults: f,
    major: sum((x) => x.major), swapIn: sum((x) => x.swapIn), swapOutPages: sum((x) => x.swapOutPages), swapInPages: sum((x) => x.swapInPages),
    has: samples.some((s) => s.faults),
  };
}

export type FaulterRow = { comm: string; procs: number; minor: number; major: number; swapIns: number; stallNs: number; maxNs: number };

// Who faulted over the visible range, by time stalled in major faults, then by minor faults
export function faulterRows(samples: Sample[]): FaulterRow[] {
  const acc = new Map<string, FaulterRow>();
  for (const s of samples) {
    if (!s.faults) continue;
    for (const p of s.procs ?? []) {
      const a = acc.get(p.comm) ?? { comm: p.comm, procs: 0, minor: 0, major: 0, swapIns: 0, stallNs: 0, maxNs: 0 };
      a.procs = Math.max(a.procs, p.procs);
      a.minor += p.minorFaults ?? 0;
      a.major += p.waitCount;
      a.swapIns += p.swapIns ?? 0;
      a.stallNs += p.waitNs;
      a.maxNs = Math.max(a.maxNs, p.waitMaxNs);
      acc.set(p.comm, a);
    }
  }
  return [...acc.values()].sort((a, b) => b.stallNs - a.stallNs || b.minor - a.minor);
}

// One sentence for the memory finding. `level` is the fault_stall level
export function faultsSentence(samples: Sample[], lang: Lang, level: Level): string {
  const tr = (k: Key, p?: Params) => translate(lang, k, p);
  const now = currentFaults(samples);
  if (!now.has) return "";
  const swap = now.faults?.swapTotalBytes
    ? tr("faults.summary.swap", { used: formatBytes(now.faults.swapUsedBytes), total: formatBytes(now.faults.swapTotalBytes), out: now.swapOutPages.toLocaleString() })
    : tr("faults.summary.noSwap");
  if (level !== "ok") {
    const top = faulterRows(samples.slice(-CURRENT_WINDOW))[0];
    return tr("faults.summary.bad", { stall: formatMsPerSec(now.stall, lang), comm: top?.comm ?? "?", from: now.major && now.swapIn / now.major > 0.5 ? tr("faults.summary.fromSwap") : tr("faults.summary.fromCache") }) + " " + swap;
  }
  return tr("faults.summary.ok", { n: now.major.toLocaleString(), swapIn: now.swapIn.toLocaleString() }) + " " + swap;
}
