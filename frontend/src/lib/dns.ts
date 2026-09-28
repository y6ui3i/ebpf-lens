// Turns dnslat samples (glibc getaddrinfo per name and per process) into what they mean for an operator.
// Whether it is "bad" is judged by the server (dns_fail / dns_slow incidents); this file only summarizes.
import type { Sample } from "../types/model";
import type { Level } from "./lens";
import { formatUs, percentile } from "./hist";
import { translate, type Key, type Lang, type Params } from "./i18n";

export const DNS_KINDS = ["dns_fail", "dns_slow"] as const;

const CURRENT_WINDOW = 5;

export const lookupsPerSec = (s: Sample) =>
  s.dns && s.intervalMs ? (s.dns.names ?? []).reduce((a, n) => a + n.lookups, 0) / (s.intervalMs / 1000) : null;

export function currentDns(samples: Sample[]) {
  const last = samples.slice(-CURRENT_WINDOW);
  const p99s = last.map((s) => percentile(s.slots, 0.99)).filter((v): v is number => v != null).sort((a, b) => a - b);
  const p99 = p99s.length ? p99s[Math.floor(p99s.length / 2)] : null;
  const rates = last.map(lookupsPerSec).filter((v): v is number => v != null);
  const fails = samples.reduce((a, s) => a + (s.dns?.names ?? []).reduce((b, n) => b + n.fails, 0), 0);
  return { p99, lookupsPerSec: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null, fails, has: samples.some((s) => s.dns) };
}

export type NameRow = { name: string; lookups: number; fails: number; lastError: string; avgNs: number; maxNs: number };

// Per-name totals over the visible range (failures first, then the slowest total)
export function nameRows(samples: Sample[]): NameRow[] {
  const acc = new Map<string, NameRow & { latNs: number }>();
  for (const s of samples) {
    for (const n of s.dns?.names ?? []) {
      let a = acc.get(n.name);
      if (!a) {
        a = { name: n.name, lookups: 0, fails: 0, lastError: "", avgNs: 0, maxNs: 0, latNs: 0 };
        acc.set(n.name, a);
      }
      a.lookups += n.lookups;
      a.fails += n.fails;
      if (n.lastError) a.lastError = n.lastError;
      a.latNs += n.latNs;
      a.maxNs = Math.max(a.maxNs, n.latMaxNs);
    }
  }
  return [...acc.values()]
    .map(({ latNs, ...r }) => ({ ...r, avgNs: r.lookups ? latNs / r.lookups : 0, total: latNs }))
    .sort((a, b) => b.fails - a.fails || b.total - a.total)
    .map(({ total: _total, ...r }) => r);
}

export type ResolverRow = { comm: string; procs: number; lookups: number; fails: number; p99: number | null; maxNs: number };

export function resolverRows(samples: Sample[]): ResolverRow[] {
  const acc = new Map<string, ResolverRow & { slots: number[] }>();
  for (const s of samples) {
    if (!s.dns) continue;
    for (const p of s.procs ?? []) {
      let a = acc.get(p.comm);
      if (!a) {
        a = { comm: p.comm, procs: 0, lookups: 0, fails: 0, p99: null, maxNs: 0, slots: new Array<number>(p.slots.length).fill(0) };
        acc.set(p.comm, a);
      }
      a.procs = Math.max(a.procs, p.procs);
      a.lookups += p.waitCount;
      a.fails += p.lookupFails ?? 0;
      a.maxNs = Math.max(a.maxNs, p.waitMaxNs);
      p.slots.forEach((c, i) => { a!.slots[i] = (a!.slots[i] ?? 0) + c; });
    }
  }
  return [...acc.values()]
    .map(({ slots, ...r }) => ({ ...r, p99: percentile(slots, 0.99) }))
    .sort((a, b) => b.fails - a.fails || b.lookups - a.lookups);
}

// EAI_* name → a phrase an operator can act on
export function dnsErrorKey(e: string): Key {
  switch (e) {
    case "NONAME": return "dns.err.NONAME";
    case "AGAIN": return "dns.err.AGAIN";
    case "FAIL": return "dns.err.FAIL";
    case "SYSTEM": return "dns.err.SYSTEM";
    default: return "dns.err.other";
  }
}

export function dnsSentence(samples: Sample[], lang: Lang, level: Level): string {
  const tr = (k: Key, p?: Params) => translate(lang, k, p);
  const now = currentDns(samples);
  if (!now.has) return tr("dns.summary.none");
  const state = now.p99 == null ? tr("dns.summary.noLookups") : tr("dns.summary.state", { rate: (now.lookupsPerSec ?? 0).toFixed(1), p99: formatUs(now.p99) });
  const top = nameRows(samples)[0];
  const fails = now.fails > 0
    ? tr("dns.summary.fails", { n: now.fails, name: top && top.fails > 0 ? top.name : "?", why: top?.lastError ? tr(dnsErrorKey(top.lastError)) : "" })
    : tr("dns.summary.clean");
  return level !== "ok" ? `${fails} ${state}` : `${state} ${fails}`;
}
