// Turns memory reclaim stalls (memstall) into what they mean for an operator.
// Whether a stall is "bad" is judged by the server (mem_stall incidents); this file only summarizes values.
import type { Sample } from "../types/model";
import type { Level } from "./lens";
import { translate, type Key, type Lang, type Params } from "./i18n";

const CURRENT_WINDOW = 5; // current value is the median of the last 5 s (so a momentary spike does not flip it)

export const stallMsPerSec = (s: Sample) =>
  s.mem && s.intervalMs ? s.mem.stallNs / 1e6 / (s.intervalMs / 1000) : null;
export const psiMsPerSec = (s: Sample) =>
  s.mem && s.intervalMs ? s.mem.psiSomeUs / 1e3 / (s.intervalMs / 1000) : null;
export const memUsed = (s: Sample) =>
  s.mem && s.mem.totalBytes ? 1 - s.mem.availableBytes / s.mem.totalBytes : null;

export function currentMem(samples: Sample[]) {
  const xs = samples.slice(-CURRENT_WINDOW).map(stallMsPerSec).filter((v): v is number => v != null).sort((a, b) => a - b);
  const stall = xs.length ? xs[Math.floor(xs.length / 2)] : null;
  const last = samples.at(-1);
  return { stall, used: last ? memUsed(last) : null, mem: last?.mem };
}

export type StallProc = {
  comm: string;
  procs: number;
  count: number;
  totalNs: number;
  maxNs: number;
  reclaimedPages: number;
  memcgCount: number;
};

// Processes that stalled on reclaim in the visible range (per name, largest total first)
export function stalledProcs(samples: Sample[]): StallProc[] {
  const acc = new Map<string, StallProc>();
  for (const s of samples) {
    for (const p of s.procs ?? []) {
      if (!p.waitCount) continue;
      let a = acc.get(p.comm);
      if (!a) {
        a = { comm: p.comm, procs: 0, count: 0, totalNs: 0, maxNs: 0, reclaimedPages: 0, memcgCount: 0 };
        acc.set(p.comm, a);
      }
      a.procs = Math.max(a.procs, p.procs);
      a.count += p.waitCount;
      a.totalNs += p.waitNs;
      a.maxNs = Math.max(a.maxNs, p.waitMaxNs);
      a.reclaimedPages += p.reclaimedPages ?? 0;
      a.memcgCount += p.memcgCount ?? 0;
    }
  }
  return [...acc.values()].sort((a, b) => b.totalNs - a.totalNs);
}

export const formatBytes = (b: number) =>
  b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : `${Math.round(b / (1 << 20))} MB`;

export const formatMsPerSec = (v: number | null, lang: Lang) => {
  const unit = translate(lang, "unit.msPerSec");
  return v == null ? "–" : v < 0.01 ? `0 ${unit}` : `${v < 10 ? v.toFixed(1) : Math.round(v)} ${unit}`;
};

// One-line sentence for the summary. Templates live in i18n.tsx because word order differs per language.
// `level` is the memory area's level from the server's mem_stall incidents; the "stalling" wording is used while it is not OK
export function memorySentence(samples: Sample[], lang: Lang, level: Level): string {
  const tr = (k: Key, p?: Params) => translate(lang, k, p);
  const now = currentMem(samples);
  const usage =
    now.used != null && now.mem
      ? tr("mem.usage", { pct: Math.round(now.used * 100), free: formatBytes(now.mem.availableBytes) })
      : "";
  const top = stalledProcs(samples)[0];
  if (level !== "ok") {
    return tr("mem.stalling", {
      stall: formatMsPerSec(now.stall, lang),
      top: top ? tr("mem.top", { comm: top.comm }) : "",
      usage,
    });
  }
  if (top) {
    const via = top.memcgCount === top.count ? tr("mem.viaMemcg") : tr("mem.viaReclaim");
    return tr("mem.recent", {
      usage, comm: top.comm, via, count: top.count.toLocaleString(), ms: (top.totalNs / 1e6).toFixed(1),
    });
  }
  return tr("mem.none", { usage });
}
