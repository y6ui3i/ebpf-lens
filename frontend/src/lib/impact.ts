// プロセス別の集計から「原因(CPU を使っていた)」と「影響(待たされた)」を組み立てる。
// エージェントは 1 秒ごとに上位のプロセスしか送らないので、長い区間の合計は近似値。
import type { Sample } from "../types/model";
import { percentile } from "./hist";

export type ProcImpact = {
  comm: string;
  procs: number; // 区間内で見えた最大のプロセス数
  onCpuNs: number;
  cpuShare: number; // CPU 全体(区間 × コア数)に占める割合 0..1
  waitCount: number;
  waitNs: number;
  waitMaxNs: number;
  p99: number | null; // 待ち時間 p99(µs)
};

// 原因とみなす CPU 占有率。これ未満なら「特定のプロセスのせい」とは言わない
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

// 要約の文章に使う。原因は CPU を大きく占有していたプロセス、影響はそれ以外で待たされたプロセス
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
