// Turns process exec / exit / OOM kill events into what they mean for an operator.
import type { ProcEvent } from "../types/model";
import type { Level } from "./lens";
import { formatTime, translate, type Key, type Lang, type Params } from "./i18n";

// Signals treated as crashes. SIGTERM / SIGKILL / SIGINT etc. are a normal way for a process to be stopped, so they are excluded
const CRASH_SIGNALS: Record<number, string> = {
  4: "SIGILL", 6: "SIGABRT", 7: "SIGBUS", 8: "SIGFPE", 11: "SIGSEGV", 31: "SIGSYS",
};
const SIGNAL_NAMES: Record<number, string> = {
  ...CRASH_SIGNALS, 1: "SIGHUP", 2: "SIGINT", 9: "SIGKILL", 13: "SIGPIPE", 15: "SIGTERM",
};

export const SHORT_LIVED_NS = 1e9; // processes that end before this are "short-lived"
const CRASH_LOOP_COUNT = 3; // warn when the same command crashes this many times or more

export const signalName = (n: number, lang: Lang) => SIGNAL_NAMES[n] ?? translate(lang, "life.signal", { n });
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

export function formatLifetime(ns: number, lang: Lang): string {
  if (ns < 1e6) return `${Math.round(ns / 1e3)} µs`;
  if (ns < 1e9) return `${(ns / 1e6).toFixed(ns < 1e7 ? 1 : 0)} ms`;
  if (ns < 60e9) return `${(ns / 1e9).toFixed(1)} ${translate(lang, "unit.s")}`;
  if (ns < 3600e9) return `${Math.round(ns / 60e9)} ${translate(lang, "unit.min")}`;
  return `${(ns / 3600e9).toFixed(1)} ${translate(lang, "unit.h")}`;
}

// One-line sentence for the summary. Templates live in i18n.tsx because word order differs per language
export function lifecycleSentence(l: Lifecycle, lang: Lang): string {
  const tr = (k: Key, p?: Params) => translate(lang, k, p);
  const hms = (t: string) => formatTime(lang, t);
  const oom = l.ooms.at(-1);
  if (oom) {
    const why = oom.memcg ? tr("life.oomWhyMemcg") : tr("life.oomWhyHost");
    const more = l.ooms.length > 1 ? tr("life.oomMore", { n: l.ooms.length - 1 }) : "";
    return tr("life.oom", { time: hms(oom.time), why, comm: oom.comm, pid: oom.pid, more });
  }
  const loop = l.crashLoops[0];
  if (loop) return tr("life.loop", { comm: loop.comm, count: loop.count });
  const crash = l.crashes.at(-1);
  if (crash) {
    return tr("life.crash", { time: hms(crash.time), comm: crash.comm, pid: crash.pid, signal: signalName(crash.signal, lang) });
  }
  return tr("life.none", { execs: l.execs.toLocaleString(), short: l.shortLived.toLocaleString() });
}
