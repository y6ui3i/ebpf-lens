// プロセスの起動・終了・OOM kill のイベントを「監視者にとっての意味」に変換する。
import type { ProcEvent } from "../types/model";
import type { Level } from "./lens";

// クラッシュとみなすシグナル。SIGTERM / SIGKILL / SIGINT などは止められた側の正常な終わり方なので含めない
const CRASH_SIGNALS: Record<number, string> = {
  4: "SIGILL", 6: "SIGABRT", 7: "SIGBUS", 8: "SIGFPE", 11: "SIGSEGV", 31: "SIGSYS",
};
const SIGNAL_NAMES: Record<number, string> = {
  ...CRASH_SIGNALS, 1: "SIGHUP", 2: "SIGINT", 9: "SIGKILL", 13: "SIGPIPE", 15: "SIGTERM",
};

export const SHORT_LIVED_NS = 1e9; // これ未満で終わったプロセスを「短命」とする
const CRASH_LOOP_COUNT = 3; // 同じコマンドがこの回数以上クラッシュしたら警告

export const signalName = (n: number) => SIGNAL_NAMES[n] ?? `シグナル ${n}`;
export const isCrash = (e: ProcEvent) => e.kind === "exit" && (e.signal in CRASH_SIGNALS || e.coreDump);
export const isErrorExit = (e: ProcEvent) => e.kind === "exit" && e.signal === 0 && e.exitStatus !== 0;

export type CommCount = { comm: string; count: number; medianNs: number; minNs: number };

export type Lifecycle = {
  execs: number;
  exits: number;
  shortLived: number;
  errorExits: number;
  crashes: ProcEvent[];
  ooms: ProcEvent[];
  crashLoops: { comm: string; count: number }[];
  shortLivedByComm: CommCount[];
  level: Level;
};

export function analyze(events: ProcEvent[]): Lifecycle {
  const exits = events.filter((e) => e.kind === "exit");
  const crashes = exits.filter(isCrash);
  const ooms = events.filter((e) => e.kind === "oom");

  const crashByComm = countBy(crashes);
  const crashLoops = [...crashByComm]
    .filter(([, n]) => n >= CRASH_LOOP_COUNT)
    .map(([comm, count]) => ({ comm, count }))
    .sort((a, b) => b.count - a.count);

  const short = exits.filter((e) => e.lifetimeNs < SHORT_LIVED_NS);
  const lifetimes = new Map<string, number[]>();
  for (const e of short) lifetimes.set(e.comm, [...(lifetimes.get(e.comm) ?? []), e.lifetimeNs]);
  const shortLivedByComm = [...lifetimes]
    .map(([comm, xs]) => {
      const s = xs.sort((a, b) => a - b);
      return { comm, count: s.length, medianNs: s[Math.floor(s.length / 2)], minNs: s[0] };
    })
    .sort((a, b) => b.count - a.count);

  const level: Level =
    ooms.length > 0 || crashLoops.length > 0 ? "warning" : crashes.length > 0 ? "caution" : "ok";

  return {
    execs: events.filter((e) => e.kind === "exec").length,
    exits: exits.length,
    shortLived: short.length,
    errorExits: exits.filter(isErrorExit).length,
    crashes,
    ooms,
    crashLoops,
    shortLivedByComm,
    level,
  };
}

function countBy(xs: ProcEvent[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x.comm, (m.get(x.comm) ?? 0) + 1);
  return m;
}

export function formatLifetime(ns: number): string {
  if (ns < 1e6) return `${Math.round(ns / 1e3)} µs`;
  if (ns < 1e9) return `${(ns / 1e6).toFixed(ns < 1e7 ? 1 : 0)} ms`;
  if (ns < 60e9) return `${(ns / 1e9).toFixed(1)} 秒`;
  if (ns < 3600e9) return `${Math.round(ns / 60e9)} 分`;
  return `${(ns / 3600e9).toFixed(1)} 時間`;
}

const hms = (t: string) => new Date(t).toLocaleTimeString("ja-JP");

// 要約に出す一文
export function lifecycleSentence(l: Lifecycle): string {
  const oom = l.ooms.at(-1);
  if (oom) {
    const why = oom.memcg ? "cgroup のメモリ上限に達したため" : "ホスト全体のメモリが不足したため";
    const more = l.ooms.length > 1 ? `(ほか ${l.ooms.length - 1} 件)` : "";
    return `${hms(oom.time)} に、${why} ${oom.comm}(pid ${oom.pid})が強制終了されました${more}。`;
  }
  const loop = l.crashLoops[0];
  if (loop) return `${loop.comm} が直近5分で ${loop.count} 回クラッシュしています。`;
  const crash = l.crashes.at(-1);
  if (crash) return `${hms(crash.time)} に ${crash.comm}(pid ${crash.pid})が ${signalName(crash.signal)} で異常終了しました。`;
  return `異常終了はありません。直近5分で ${l.execs.toLocaleString()} 回起動し、うち ${l.shortLived.toLocaleString()} 件は1秒未満で終わりました。`;
}
