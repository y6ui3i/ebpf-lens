// Turns tcpconn samples (outbound TCP connects, failures and retransmits per destination and per process) into
// what they mean for an operator. Whether it is "bad" is judged by the server (net_* incidents); this file only summarizes.
import type { Sample } from "../types/model";
import type { Level } from "./lens";
import { formatUs, percentile } from "./hist";
import { translate, type Key, type Lang, type Params } from "./i18n";

export const NET_KINDS = ["net_connect_fail", "net_connect_slow", "net_retrans"] as const;

const CURRENT_WINDOW = 5;

const perSec = (s: Sample, f: (s: Sample) => number) => (s.net && s.intervalMs ? f(s) / (s.intervalMs / 1000) : null);
export const connectsPerSec = (s: Sample) => perSec(s, (x) => (x.net?.dests ?? []).reduce((a, d) => a + d.connects, 0));
export const failsPerSec = (s: Sample) => perSec(s, (x) => (x.net?.dests ?? []).reduce((a, d) => a + d.fails, 0));
export const retransPerSec = (s: Sample) => perSec(s, (x) => (x.net?.dests ?? []).reduce((a, d) => a + d.retrans, 0));

// The network right now: connect p99 as the median of the last 5 s, rates as the mean; failures and retransmits summed over the window
export function currentNet(samples: Sample[]) {
  const last = samples.slice(-CURRENT_WINDOW);
  const p99s = last.map((s) => percentile(s.slots, 0.99)).filter((v): v is number => v != null).sort((a, b) => a - b);
  const p99 = p99s.length ? p99s[Math.floor(p99s.length / 2)] : null;
  const mean = (f: (s: Sample) => number | null) => {
    const xs = last.map(f).filter((v): v is number => v != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const sum = (f: (d: { fails: number; retrans: number }) => number) =>
    samples.reduce((a, s) => a + (s.net?.dests ?? []).reduce((b, d) => b + f(d), 0), 0);
  return { p99, connectsPerSec: mean(connectsPerSec), fails: sum((d) => d.fails), retrans: sum((d) => d.retrans), has: samples.some((s) => s.net) };
}

export type DestRow = { dest: string; connects: number; fails: number; retrans: number; avgNs: number; maxNs: number };

// Per-destination totals over the visible range (trouble first: failures, then retransmits, then volume)
export function destRows(samples: Sample[]): DestRow[] {
  const acc = new Map<string, DestRow & { latNs: number }>();
  for (const s of samples) {
    for (const d of s.net?.dests ?? []) {
      const dest = d.port ? `${d.addr}:${d.port}` : `${d.addr} (inbound)`; // port 0: retransmits to clients that connected to us
      let a = acc.get(dest);
      if (!a) {
        a = { dest, connects: 0, fails: 0, retrans: 0, avgNs: 0, maxNs: 0, latNs: 0 };
        acc.set(dest, a);
      }
      a.connects += d.connects;
      a.fails += d.fails;
      a.retrans += d.retrans;
      a.latNs += d.latNs;
      a.maxNs = Math.max(a.maxNs, d.latMaxNs);
    }
  }
  return [...acc.values()]
    .map(({ latNs, ...r }) => ({ ...r, avgNs: r.connects ? latNs / r.connects : 0 }))
    .sort((a, b) => b.fails - a.fails || b.retrans - a.retrans || b.connects - a.connects);
}

export type ConnectorRow = { comm: string; procs: number; connects: number; fails: number; p99: number | null; maxNs: number };

// Who opened connections in the visible range (failures first, then volume)
export function connectorRows(samples: Sample[]): ConnectorRow[] {
  const acc = new Map<string, ConnectorRow & { slots: number[] }>();
  for (const s of samples) {
    if (!s.net) continue;
    for (const p of s.procs ?? []) {
      let a = acc.get(p.comm);
      if (!a) {
        a = { comm: p.comm, procs: 0, connects: 0, fails: 0, p99: null, maxNs: 0, slots: new Array<number>(p.slots.length).fill(0) };
        acc.set(p.comm, a);
      }
      a.procs = Math.max(a.procs, p.procs);
      a.connects += p.waitCount;
      a.fails += p.connectFails ?? 0;
      a.maxNs = Math.max(a.maxNs, p.waitMaxNs);
      p.slots.forEach((c, i) => { a!.slots[i] = (a!.slots[i] ?? 0) + c; });
    }
  }
  return [...acc.values()]
    .map(({ slots, ...r }) => ({ ...r, p99: percentile(slots, 0.99) }))
    .sort((a, b) => b.fails - a.fails || b.connects - a.connects);
}

// One-line sentence for the summary. `level` is the network area's level from the server's incidents
export function netSentence(samples: Sample[], lang: Lang, level: Level): string {
  const tr = (k: Key, p?: Params) => translate(lang, k, p);
  const now = currentNet(samples);
  if (!now.has) return tr("net.summary.none");
  const top = destRows(samples.slice(-CURRENT_WINDOW))[0];
  const state = tr("net.summary.state", { rate: (now.connectsPerSec ?? 0).toFixed(1), p99: formatUs(now.p99) });
  const parts: string[] = [];
  if (now.fails > 0) parts.push(tr("net.summary.fails", { n: now.fails, dest: top && top.fails > 0 ? tr("net.summary.mostly", { dest: top.dest }) : "" }));
  if (now.retrans > 0) parts.push(tr("net.summary.retrans", { n: now.retrans, dest: top && top.retrans > 0 ? tr("net.summary.mostly", { dest: top.dest }) : "" }));
  const trouble = parts.join(" ");
  if (level !== "ok") return `${trouble} ${state}`.trim();
  return `${state} ${trouble || tr("net.summary.clean")}`.trim();
}
