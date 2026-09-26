// Builds "cause" (who was using the CPU) and "impact" (who was kept waiting) from per-process stats.
// The agent sends only the top processes each second, so totals over long ranges are approximate.
import type { Sample } from "../types/model";
import { percentile } from "./hist";

export type ProcImpact = {
  comm: string;
  procs: number; // max number of processes seen in the range
  onCpuNs: number;
  cpuShare: number; // share of total CPU (range x cores), 0..1
  waitCount: number;
  waitNs: number;
  waitMaxNs: number;
  p99: number | null; // wait time p99 (µs)
};

// CPU share needed to call a process the cause. Below this we do not blame a specific process
const CULPRIT_SHARE = 0.3;

export function samplesBetween(samples: Sample[], start: Date, end: Date): Sample[] {
  const a = start.getTime();
  const b = end.getTime();
  return samples.filter((s) => {
    const t = Date.parse(s.time);
    return t >= a && t <= b;
  });
}

export function impact(samples: Sample[]): ProcImpact[] {
  let capacityNs = 0;
  const acc = new Map<string, Omit<ProcImpact, "cpuShare" | "p99"> & { slots: number[] }>();
  for (const s of samples) {
    capacityNs += s.intervalMs * 1e6 * s.cpus;
    for (const p of s.procs ?? []) {
      let a = acc.get(p.comm);
      if (!a) {
        a = { comm: p.comm, procs: 0, onCpuNs: 0, waitCount: 0, waitNs: 0, waitMaxNs: 0, slots: [] };
        acc.set(p.comm, a);
      }
      a.procs = Math.max(a.procs, p.procs);
      a.onCpuNs += p.onCpuNs;
      a.waitCount += p.waitCount;
      a.waitNs += p.waitNs;
      a.waitMaxNs = Math.max(a.waitMaxNs, p.waitMaxNs);
      p.slots.forEach((c, i) => (a.slots[i] = (a.slots[i] ?? 0) + c));
    }
  }
  return [...acc.values()].map(({ slots, ...a }) => ({
    ...a,
    cpuShare: capacityNs ? a.onCpuNs / capacityNs : 0,
    p99: percentile(slots, 0.99),
  }));
}

export const byCpu = (xs: ProcImpact[]) => [...xs].sort((a, b) => b.onCpuNs - a.onCpuNs);
export const byWait = (xs: ProcImpact[]) => [...xs].filter((x) => x.waitCount > 0).sort((a, b) => b.waitNs - a.waitNs);

// Used by the summary sentence. The cause is a process that held a large share of CPU; the impact is the other processes that were kept waiting
export function explain(xs: ProcImpact[]) {
  const top = byCpu(xs)[0];
  const culprit = top && top.cpuShare >= CULPRIT_SHARE ? top : undefined;
  const victims = byWait(xs).filter((x) => x.comm !== culprit?.comm).slice(0, 2);
  return { culprit, victims };
}

export function procLabel(p: { comm: string; procs: number }): string {
  return p.procs > 1 ? `${p.comm} ×${p.procs}` : p.comm;
}

export function formatMs(ns: number): string {
  const ms = ns / 1e6;
  if (ms < 1) return `${(ns / 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
