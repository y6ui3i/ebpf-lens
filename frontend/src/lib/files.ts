// Turns fileops samples (failed opens per process/path/errno, fsync waits per file and per process) into what
// they mean for an operator. Whether it is "bad" is judged by the server (file_fail / fsync_slow); this file only summarizes.
import type { Sample } from "../types/model";
import type { Level } from "./lens";
import { formatUs, percentile } from "./hist";
import { translate, type Key, type Lang, type Params } from "./i18n";

export const FILE_KINDS = ["file_fail", "fsync_slow"] as const;

const CURRENT_WINDOW = 5;

export type FileTier = "trouble" | "notable" | "noise";
const TIER_RANK: Record<FileTier, number> = { trouble: 0, notable: 1, noise: 2 };
export const asTier = (s: string): FileTier => (s === "trouble" || s === "notable" ? s : "noise");

export const fsyncsPerSec = (s: Sample) =>
  s.files && s.intervalMs ? (s.files.fsyncs ?? []).reduce((a, f) => a + f.fsyncs, 0) / (s.intervalMs / 1000) : null;

// Failed opens of the trouble tier, summed over the samples (ENOENT and the pseudo file systems do not count)
export const troubleFails = (samples: Sample[]) =>
  samples.reduce((a, s) => a + (s.files?.openFails ?? []).reduce((b, f) => b + (f.tier === "trouble" ? f.count : 0), 0), 0);

// The files right now: fsync p99 as the median of the last 5 s, fsyncs/s as the mean; failures over the window
export function currentFiles(samples: Sample[]) {
  const last = samples.slice(-CURRENT_WINDOW);
  const p99s = last.map((s) => percentile(s.slots, 0.99)).filter((v): v is number => v != null).sort((a, b) => a - b);
  const p99 = p99s.length ? p99s[Math.floor(p99s.length / 2)] : null;
  const rates = last.map(fsyncsPerSec).filter((v): v is number => v != null);
  const allFails = samples.reduce((a, s) => a + (s.files?.openErrs ?? []).reduce((b, e) => b + e.count, 0), 0);
  return {
    p99, fsyncsPerSec: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
    fails: troubleFails(samples), allFails, has: samples.some((s) => s.files),
  };
}

export type OpenFailRow = { key: string; comm: string; path: string; error: string; tier: FileTier; count: number };

// Failed opens over the visible range: trouble first, then notable, then by count (noise rows stay at the end)
export function openFailRows(samples: Sample[]): OpenFailRow[] {
  const acc = new Map<string, OpenFailRow>();
  for (const s of samples) {
    for (const f of s.files?.openFails ?? []) {
      const key = `${f.comm}|${f.error}|${f.path}`;
      const a = acc.get(key) ?? { key, comm: f.comm, path: f.path, error: f.error, tier: asTier(f.tier), count: 0 };
      a.count += f.count;
      acc.set(key, a);
    }
  }
  return [...acc.values()].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.count - a.count);
}

export type ErrRow = { error: string; count: number };

// Failed opens by errno over the visible range (every tier, including the noise that never gets a row)
export function errRows(samples: Sample[]): ErrRow[] {
  const acc = new Map<string, number>();
  for (const s of samples) for (const e of s.files?.openErrs ?? []) acc.set(e.error, (acc.get(e.error) ?? 0) + e.count);
  return [...acc.entries()].map(([error, count]) => ({ error, count })).sort((a, b) => b.count - a.count);
}

export type FsyncRow = { name: string; fsyncs: number; avgNs: number; maxNs: number; totalNs: number };

// fsync by file over the visible range, by total time (the file that cost the most wait first)
export function fsyncRows(samples: Sample[]): FsyncRow[] {
  const acc = new Map<string, FsyncRow>();
  for (const s of samples) {
    for (const f of s.files?.fsyncs ?? []) {
      const a = acc.get(f.name) ?? { name: f.name, fsyncs: 0, avgNs: 0, maxNs: 0, totalNs: 0 };
      a.fsyncs += f.fsyncs;
      a.totalNs += f.latNs;
      a.maxNs = Math.max(a.maxNs, f.latMaxNs);
      acc.set(f.name, a);
    }
  }
  return [...acc.values()].map((r) => ({ ...r, avgNs: r.fsyncs ? r.totalNs / r.fsyncs : 0 })).sort((a, b) => b.totalNs - a.totalNs);
}

export type SyncerRow = { comm: string; procs: number; fsyncs: number; openFails: number; p99: number | null; maxNs: number };

// Who fsynced and who failed to open, over the visible range (failures first, then fsync count)
export function syncerRows(samples: Sample[]): SyncerRow[] {
  const acc = new Map<string, SyncerRow & { slots: number[] }>();
  for (const s of samples) {
    if (!s.files) continue;
    for (const p of s.procs ?? []) {
      let a = acc.get(p.comm);
      if (!a) {
        a = { comm: p.comm, procs: 0, fsyncs: 0, openFails: 0, p99: null, maxNs: 0, slots: new Array<number>(p.slots.length).fill(0) };
        acc.set(p.comm, a);
      }
      a.procs = Math.max(a.procs, p.procs);
      a.fsyncs += p.waitCount;
      a.openFails += p.openFails ?? 0;
      a.maxNs = Math.max(a.maxNs, p.waitMaxNs);
      p.slots.forEach((c, i) => { a!.slots[i] = (a!.slots[i] ?? 0) + c; });
    }
  }
  return [...acc.values()]
    .map(({ slots, ...r }) => ({ ...r, p99: percentile(slots, 0.99) }))
    .sort((a, b) => b.openFails - a.openFails || b.fsyncs - a.fsyncs);
}

// The meaning of an errno, when we have words for it (files.err.<ERRNO>); otherwise the name itself
export function errExplain(error: string, lang: Lang): string {
  const k = `files.err.${error}` as Key;
  const s = translate(lang, k);
  return s === k ? error : s;
}

// One-line sentence for the summary. `level` is the area's level from the server's incidents
export function filesSentence(samples: Sample[], lang: Lang, level: Level): string {
  const tr = (k: Key, p?: Params) => translate(lang, k, p);
  const now = currentFiles(samples);
  if (!now.has) return tr("files.summary.none");
  const state = now.p99 == null ? tr("files.summary.noFsync") : tr("files.summary.state", { rate: (now.fsyncsPerSec ?? 0).toFixed(1), p99: formatUs(now.p99) });
  const parts: string[] = [];
  if (now.fails > 0) {
    const top = openFailRows(samples).find((r) => r.tier === "trouble");
    parts.push(tr("files.summary.fails", { n: now.fails, what: top ? tr("files.summary.failWhat", { comm: top.comm, path: top.path, err: errExplain(top.error, lang) }) : "" }));
  }
  if (level !== "ok" && now.p99 != null) {
    const top = fsyncRows(samples.slice(-CURRENT_WINDOW))[0];
    if (top) parts.push(tr("files.summary.slowFile", { name: top.name }));
  }
  const trouble = parts.join(" ");
  if (level !== "ok") return `${trouble} ${state}`.trim();
  return `${state} ${trouble || tr("files.summary.clean")}`.trim();
}
