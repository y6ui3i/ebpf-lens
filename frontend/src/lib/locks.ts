// Turns lockwait samples (contended user-space locks via futex, kernel lock contention) into what they mean for an
// operator. Whether it is "bad" is judged by the server (lock_wait); this file only summarizes.
import type { Sample } from "../types/model";
import type { Level } from "./lens";
import { percentile } from "./hist";
import { translate, type Key, type Lang, type Params } from "./i18n";

export const LOCK_KINDS = ["lock_wait"] as const;

const CURRENT_WINDOW = 5;

// Seconds of lock waiting per second of wall time, host-wide (user + kernel): 1.0 = one thread's worth blocked
export const lockSecPerSec = (s: Sample) => {
  if (!s.lock || !s.intervalMs) return null;
  const k = (s.lock.kernel ?? []).reduce((a, x) => a + x.latNs, 0);
  return (s.lock.userNs + k) / 1e9 / (s.intervalMs / 1000);
};
export const userWaitsPerSec = (s: Sample) => (s.lock && s.intervalMs ? s.lock.userWaits / (s.intervalMs / 1000) : null);

// The locks right now: wait p99 as the median of the last 5 s, the rates as the mean
export function currentLocks(samples: Sample[]) {
  const last = samples.slice(-CURRENT_WINDOW);
  const p99s = last.map((s) => percentile(s.slots, 0.99)).filter((v): v is number => v != null).sort((a, b) => a - b);
  const p99 = p99s.length ? p99s[Math.floor(p99s.length / 2)] : null;
  const mean = (f: (s: Sample) => number | null) => {
    const xs = last.map(f).filter((v): v is number => v != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const kernelNs = last.reduce((a, s) => a + (s.lock?.kernel ?? []).reduce((b, k) => b + k.latNs, 0), 0);
  const userNs = last.reduce((a, s) => a + (s.lock?.userNs ?? 0), 0);
  return { p99, secPerSec: mean(lockSecPerSec), waitsPerSec: mean(userWaitsPerSec), userNs, kernelNs, has: samples.some((s) => s.lock) };
}

export type WaiterRow = { comm: string; procs: number; locks: number; waits: number; userNs: number; kernelNs: number; kernelCount: number; p99: number | null; maxNs: number; secPerSec: number };

// Who waited for locks over the visible range, by total time (user + kernel); secPerSec is averaged over the range
export function waiterRows(samples: Sample[]): WaiterRow[] {
  const acc = new Map<string, WaiterRow & { slots: number[] }>();
  let wallMs = 0;
  for (const s of samples) {
    if (!s.lock) continue;
    wallMs += s.intervalMs || 1000;
    for (const p of s.procs ?? []) {
      let a = acc.get(p.comm);
      if (!a) {
        a = { comm: p.comm, procs: 0, locks: 0, waits: 0, userNs: 0, kernelNs: 0, kernelCount: 0, p99: null, maxNs: 0, secPerSec: 0, slots: new Array<number>(p.slots.length).fill(0) };
        acc.set(p.comm, a);
      }
      a.procs = Math.max(a.procs, p.procs);
      a.locks = Math.max(a.locks, p.locks ?? 0);
      a.waits += p.waitCount;
      a.userNs += p.waitNs;
      a.kernelNs += p.kernelLockNs ?? 0;
      a.kernelCount += p.kernelLockCount ?? 0;
      a.maxNs = Math.max(a.maxNs, p.waitMaxNs);
      p.slots.forEach((c, i) => { a!.slots[i] = (a!.slots[i] ?? 0) + c; });
    }
  }
  return [...acc.values()]
    .map(({ slots, ...r }) => ({ ...r, p99: percentile(slots, 0.99), secPerSec: wallMs ? (r.userNs + r.kernelNs) / 1e6 / wallMs : 0 }))
    .sort((a, b) => b.userNs + b.kernelNs - (a.userNs + a.kernelNs));
}

export type KindRow = { kind: string; count: number; latNs: number };

// Kernel lock contention by kind over the visible range, by total time
export function kindRows(samples: Sample[]): KindRow[] {
  const acc = new Map<string, KindRow>();
  for (const s of samples) {
    for (const k of s.lock?.kernel ?? []) {
      const a = acc.get(k.kind) ?? { kind: k.kind, count: 0, latNs: 0 };
      a.count += k.count;
      a.latNs += k.latNs;
      acc.set(k.kind, a);
    }
  }
  return [...acc.values()].sort((a, b) => b.latNs - a.latNs);
}

// The kernel's lock kind in words (locks.kind.<kind>), or the kind itself
export function kindLabel(kind: string, lang: Lang): string {
  const k = `locks.kind.${kind}` as Key;
  const s = translate(lang, k);
  return s === k ? kind : s;
}

// One-line sentence for the summary. `level` is the area's level from the server's lock_wait incidents
export function locksSentence(samples: Sample[], lang: Lang, level: Level): string {
  const tr = (k: Key, p?: Params) => translate(lang, k, p);
  const now = currentLocks(samples);
  if (!now.has) return tr("locks.summary.none");
  const top = waiterRows(samples.slice(-CURRENT_WINDOW))[0];
  const state = now.secPerSec == null || now.secPerSec < 0.005
    ? tr("locks.summary.quiet")
    : tr("locks.summary.state", { n: now.secPerSec.toFixed(1), who: top ? tr("locks.summary.who", { comm: top.comm, n: top.secPerSec.toFixed(1) }) : "" });
  if (level !== "ok" && top) return `${tr("locks.summary.bad", { comm: top.comm, n: top.secPerSec.toFixed(1), where: top.kernelNs > top.userNs ? tr("locks.summary.kernel") : tr("locks.summary.user") })} ${state}`;
  return state;
}
