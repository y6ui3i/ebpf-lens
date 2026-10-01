// Turns irqlat samples (softirq per CPU and vector, hardirq per line) into what they mean for an operator.
// Whether it is "bad" is judged by the server (irq_busy); this file only summarizes.
import type { Sample } from "../types/model";
import type { Level } from "./lens";
import { translate, type Key, type Lang, type Params } from "./i18n";

export const IRQ_KINDS = ["irq_busy"] as const;

const CURRENT_WINDOW = 5;

// Share of all CPU time spent in interrupt context (softirq + hardirq), 0..1
export const irqShare = (s: Sample) => {
  if (!s.irq || !s.intervalMs || !s.cpus) return null;
  const ns = s.irq.cpus.reduce((a, c) => a + c.softirqNs + c.irqNs, 0);
  return ns / (s.intervalMs * 1e6 * s.cpus);
};

// The busiest CPU's share of its own time in interrupt context, 0..1
export const busiestCpuShare = (s: Sample) => {
  if (!s.irq || !s.intervalMs) return null;
  let m = 0;
  for (const c of s.irq.cpus) m = Math.max(m, (c.softirqNs + c.irqNs) / (s.intervalMs * 1e6));
  return m;
};

export function currentIrq(samples: Sample[]) {
  const last = samples.slice(-CURRENT_WINDOW);
  const mean = (f: (s: Sample) => number | null) => {
    const xs = last.map(f).filter((v): v is number => v != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const irqsPerSec = mean((s) => (s.irq && s.intervalMs ? s.irq.cpus.reduce((a, c) => a + c.irqCount, 0) / (s.intervalMs / 1000) : null));
  const busiest = busiestCpu(last);
  return { share: mean(irqShare), busiestShare: mean(busiestCpuShare), busiest, irqsPerSec, has: samples.some((s) => s.irq) };
}

export type CpuRow = { cpu: number; softirqNs: number; irqNs: number; irqCount: number; share: number; topVec: string };

// Per CPU over the range: time in softirq and hardirq, its share of that CPU's time, and its busiest vector
export function cpuRows(samples: Sample[]): CpuRow[] {
  const acc = new Map<number, CpuRow & { vecs: Map<string, number> }>();
  let wallNs = 0;
  for (const s of samples) {
    if (!s.irq) continue;
    wallNs += (s.intervalMs || 1000) * 1e6;
    for (const c of s.irq.cpus) {
      const a = acc.get(c.cpu) ?? { cpu: c.cpu, softirqNs: 0, irqNs: 0, irqCount: 0, share: 0, topVec: "", vecs: new Map() };
      a.softirqNs += c.softirqNs;
      a.irqNs += c.irqNs;
      a.irqCount += c.irqCount;
      acc.set(c.cpu, a);
    }
    for (const v of s.irq.softirqs ?? []) {
      const a = acc.get(v.cpu);
      if (a) a.vecs.set(v.vec, (a.vecs.get(v.vec) ?? 0) + v.ns);
    }
  }
  return [...acc.values()]
    .map(({ vecs, ...r }) => ({ ...r, share: wallNs ? (r.softirqNs + r.irqNs) / wallNs : 0, topVec: [...vecs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "" }))
    .sort((a, b) => a.cpu - b.cpu);
}

function busiestCpu(samples: Sample[]): CpuRow | undefined {
  return [...cpuRows(samples)].sort((a, b) => b.share - a.share)[0];
}

export type VecRow = { vec: string; count: number; ns: number };

// Softirq vectors host-wide over the range, by time
export function vecRows(samples: Sample[]): VecRow[] {
  const acc = new Map<string, VecRow>();
  for (const s of samples) {
    for (const v of s.irq?.softirqs ?? []) {
      const a = acc.get(v.vec) ?? { vec: v.vec, count: 0, ns: 0 };
      a.count += v.count;
      a.ns += v.ns;
      acc.set(v.vec, a);
    }
  }
  return [...acc.values()].sort((a, b) => b.ns - a.ns);
}

export type IrqRow = { irq: number; name: string; count: number; ns: number };

// IRQ lines over the range, by time
export function irqRows(samples: Sample[]): IrqRow[] {
  const acc = new Map<number, IrqRow>();
  for (const s of samples) {
    for (const q of s.irq?.irqs ?? []) {
      const a = acc.get(q.irq) ?? { irq: q.irq, name: q.name, count: 0, ns: 0 };
      a.count += q.count;
      a.ns += q.ns;
      acc.set(q.irq, a);
    }
  }
  return [...acc.values()].sort((a, b) => b.ns - a.ns);
}

// A vector's meaning in words (irq.vec.<VEC>), or the name itself
export function vecLabel(vec: string, lang: Lang): string {
  const k = `irq.vec.${vec}` as Key;
  const s = translate(lang, k);
  return s === k ? vec : s;
}

export function irqSentence(samples: Sample[], lang: Lang, level: Level): string {
  const tr = (k: Key, p?: Params) => translate(lang, k, p);
  const now = currentIrq(samples);
  if (!now.has) return tr("irq.summary.none");
  const pct = (v: number | null) => (v == null ? "–" : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`);
  const state = tr("irq.summary.state", { all: pct(now.share), cpu: now.busiest ? `cpu${now.busiest.cpu}` : "?", busiest: pct(now.busiestShare), vec: now.busiest?.topVec ?? "" });
  if (level !== "ok" && now.busiest) return `${tr("irq.summary.bad", { cpu: `cpu${now.busiest.cpu}`, pct: pct(now.busiestShare), vec: now.busiest.topVec })} ${state}`;
  return state;
}
