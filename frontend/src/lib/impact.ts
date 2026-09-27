// Builds "cause" (who was using the CPU) and "impact" (who was kept waiting) from per-process stats.
// The agent sends only the top processes each second, so totals over long ranges are approximate.
import type { Incident, Sample } from "../types/model";
import { percentile } from "./hist";
import type { TFn } from "./i18n";

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

// Culprit grouping, the same rule the server applies (trigger.GroupCulprits): consumers with at least
// CULPRIT_MIN_SHARE of the host, largest first, at most CULPRIT_MAX of them, and only if together they used at least
// CULPRIT_TOTAL_SHARE. One hog at 99 % is a group of one; three VMs at 34/24/23 % are a group of three; ten processes
// at 7 % each are no group at all (the CPU is simply shared)
export const CULPRIT_MIN_SHARE = 0.1;
export const CULPRIT_TOTAL_SHARE = 0.5;
export const CULPRIT_MAX = 5;

// One member of the group as shown to the reader. procs is known only when the member appears in the samples at hand
export type CulpritMember = { name: string; share: number; procs?: number };

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

// Share of the host's CPU capacity that was busy over the samples (0..1); null without usable samples
export function hostBusyShare(samples: Sample[]): number | null {
  let busy = 0;
  let cap = 0;
  for (const s of samples) {
    if (!(s.cpus > 0 && s.intervalMs > 0)) continue;
    busy += s.busyNs;
    cap += s.intervalMs * 1e6 * s.cpus;
  }
  return cap > 0 ? Math.min(1, busy / cap) : null;
}

// Applies the grouping rule to per-name CPU shares (fractions of the host's capacity). Mirrors trigger.GroupCulprits
// so that the frontend and the server agree. Returns the group (largest first) and its combined share;
// an empty group means no one stands out
export function groupCulprits<T extends { name: string; share: number }>(shares: T[]): { group: T[]; total: number } {
  const group = shares
    .filter((s) => s.share >= CULPRIT_MIN_SHARE)
    .sort((a, b) => b.share - a.share || a.name.localeCompare(b.name))
    .slice(0, CULPRIT_MAX);
  const total = group.reduce((a, s) => a + s.share, 0);
  return total >= CULPRIT_TOTAL_SHARE ? { group, total } : { group: [], total: 0 };
}

// Used by the summary sentence. The cause is the group that held a large share of CPU; the impact is the other processes
// that were kept waiting (group members are not victims, even if they waited too)
export function explain(xs: ProcImpact[]) {
  const { group, total } = groupCulprits(xs.map((x) => ({ name: x.comm, share: x.cpuShare, x })));
  const culprits = group.map((g) => g.x);
  const names = new Set(culprits.map((c) => c.comm));
  const victims = byWait(xs).filter((x) => !names.has(x.comm)).slice(0, 2);
  return { culprits, culpritShare: total, victims };
}

// The culprit group to show for an incident, and how busy the host was.
// The server's judgement is preferred when the incident carries one, because it saw the whole window: `culprits` present
// means it found a group; `culprits` absent but `hostBusy` present means it found none. Incidents from before the server
// judged culprits carry neither, and then the same rule is applied to the samples at hand
export type CulpritView = { members: CulpritMember[]; total: number; busy: number | null; fromServer: boolean };

export function culpritsFor(
  inc: Pick<Incident, "culprits" | "culpritShare" | "hostBusy"> | undefined,
  xs: ProcImpact[],
  range: Sample[],
): CulpritView {
  if (inc && (inc.culprits != null || inc.hostBusy != null)) {
    const members = (inc.culprits ?? []).map((c) => ({ name: c.name, share: c.share, procs: xs.find((x) => x.comm === c.name)?.procs }));
    const total = inc.culpritShare ?? members.reduce((a, m) => a + m.share, 0);
    return { members, total, busy: inc.hostBusy ?? hostBusyShare(range), fromServer: true };
  }
  const { culprits, culpritShare } = explain(xs);
  return {
    members: culprits.map((c) => ({ name: c.comm, share: c.cpuShare, procs: c.procs })),
    total: culpritShare,
    busy: hostBusyShare(range),
    fromServer: false,
  };
}

export const pct = (share: number) => Math.round(share * 100);

// "comm (3 processes) (34%)" for one group member
export function memberLabel(m: CulpritMember, t: TFn): string {
  const who = (m.procs ?? 1) > 1 ? t("cause.who", { comm: m.name, n: m.procs! }) : m.name;
  return t("cause.member", { who, pct: pct(m.share) });
}

// "a (34%), b (24%), c (23%)"; with `and` the last member is joined with "and" (a sentence), otherwise with commas (a list).
// At most `max` members are named; the rest become "+n"
export function culpritList(members: CulpritMember[], t: TFn, opts: { and?: boolean; max?: number } = {}): string {
  const max = opts.max ?? members.length;
  const named = members.slice(0, max).map((m) => memberLabel(m, t));
  const more = members.length > max ? t("incident.more", { n: members.length - max }) : "";
  if (opts.and && named.length > 1 && !more) {
    return named.slice(0, -1).join(t("list.sep")) + t("list.and") + named[named.length - 1];
  }
  return named.join(t("list.sep")) + more;
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
