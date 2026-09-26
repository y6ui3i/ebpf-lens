// メモリ回収による停止(memstall)を「監視者にとっての意味」に変換する。
import type { Sample } from "../types/model";
import type { Level } from "./lens";

// しきい値(仮)。1 秒あたりに全プロセスが回収で止まった時間の合計。
// hal の平常時は 0。cgroup 上限 64MB の中で 3GB のファイルを読ませても約 8 ms/秒だった
export const CAUTION_MS_PER_S = 10;
export const WARNING_MS_PER_S = 100;
const CURRENT_WINDOW = 5; // 直近 5 秒の中央値で判定する(一瞬の山で揺らさない)

export const stallMsPerSec = (s: Sample) =>
  s.mem && s.intervalMs ? s.mem.stallNs / 1e6 / (s.intervalMs / 1000) : null;
export const psiMsPerSec = (s: Sample) =>
  s.mem && s.intervalMs ? s.mem.psiSomeUs / 1e3 / (s.intervalMs / 1000) : null;
export const memUsed = (s: Sample) =>
  s.mem && s.mem.totalBytes ? 1 - s.mem.availableBytes / s.mem.totalBytes : null;

export function levelOf(msPerSec: number | null): Level {
  if (msPerSec == null || msPerSec < CAUTION_MS_PER_S) return "ok";
  return msPerSec < WARNING_MS_PER_S ? "caution" : "warning";
}

export function currentMem(samples: Sample[]) {
  const xs = samples.slice(-CURRENT_WINDOW).map(stallMsPerSec).filter((v): v is number => v != null).sort((a, b) => a - b);
  const stall = xs.length ? xs[Math.floor(xs.length / 2)] : null;
  const last = samples.at(-1);
  return { stall, level: levelOf(stall), used: last ? memUsed(last) : null, mem: last?.mem };
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

// 表示範囲の中で回収で止まったプロセス(名前ごと、合計の多い順)
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

export const formatMsPerSec = (v: number | null) =>
  v == null ? "–" : v < 0.01 ? "0 ms/秒" : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms/秒`;

// 要約に出す一文
export function memorySentence(samples: Sample[]): string {
  const now = currentMem(samples);
  const usage =
    now.used != null && now.mem ? `使用率 ${Math.round(now.used * 100)}%、空き ${formatBytes(now.mem.availableBytes)}` : "";
  const top = stalledProcs(samples)[0];
  if (now.level !== "ok") {
    return `メモリの回収で、プロセスが合計 ${formatMsPerSec(now.stall)} 止まっています${top ? `(一番は ${top.comm})` : ""}。${usage}。`;
  }
  if (top) {
    const memcg = top.memcgCount === top.count ? "cgroup の上限による回収で" : "メモリの回収で";
    return `今は止まっていません(${usage})。直近5分では ${top.comm} が${memcg} ${top.count.toLocaleString()} 回、合計 ${(top.totalNs / 1e6).toFixed(1)} ms 止まりました。`;
  }
  return `メモリの回収で止まったプロセスはありません(${usage})。`;
}
