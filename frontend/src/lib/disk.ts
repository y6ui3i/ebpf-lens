// Turns biolat samples (block I/O latency per device and per issuing process) into what they mean for an
// operator. Whether latency is "bad" is judged by the server (disk_slow / disk_error incidents); this file only summarizes.
import type { DiskDev, Sample } from "../types/model";
import type { Level } from "./lens";
import { formatUs, percentile } from "./hist";
import { translate, type Key, type Lang, type Params } from "./i18n";
import { formatBytes } from "./memory";

export const DISK_KINDS = ["disk_slow", "disk_error"] as const;

const CURRENT_WINDOW = 5;

// Bytes moved and I/Os per second in one sample, over all devices
export const diskBytesPerSec = (s: Sample) =>
  s.disk && s.intervalMs ? (s.disk.devices ?? []).reduce((a, d) => a + d.readBytes + d.writeBytes, 0) / (s.intervalMs / 1000) : null;
export const diskIops = (s: Sample) =>
  s.disk && s.intervalMs ? (s.disk.devices ?? []).reduce((a, d) => a + d.reads + d.writes, 0) / (s.intervalMs / 1000) : null;

// The disks right now: p99 as the median of the last 5 s (a single slow second does not flip it), throughput as the mean
export function currentDisk(samples: Sample[]) {
  const last = samples.slice(-CURRENT_WINDOW);
  const p99s = last.map((s) => percentile(s.slots, 0.99)).filter((v): v is number => v != null).sort((a, b) => a - b);
  const p99 = p99s.length ? p99s[Math.floor(p99s.length / 2)] : null;
  const mean = (f: (s: Sample) => number | null) => {
    const xs = last.map(f).filter((v): v is number => v != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const errors = samples.reduce((a, s) => a + ((s.disk?.devices ?? []).reduce((b, d) => b + d.errors, 0)), 0);
  return { p99, bytesPerSec: mean(diskBytesPerSec), iops: mean(diskIops), errors, has: samples.some((s) => s.disk) };
}

export type DeviceRow = {
  name: string;
  reads: number;
  writes: number;
  readBytes: number;
  writeBytes: number;
  errors: number;
  p99: number | null;
  maxNs: number;
  seconds: number;
};

// Per-device totals over the visible range (busiest first)
export function deviceRows(samples: Sample[]): DeviceRow[] {
  const acc = new Map<string, DeviceRow & { slots: number[] }>();
  for (const s of samples) {
    for (const d of s.disk?.devices ?? []) {
      let a = acc.get(d.name);
      if (!a) {
        a = { name: d.name, reads: 0, writes: 0, readBytes: 0, writeBytes: 0, errors: 0, p99: null, maxNs: 0, seconds: 0, slots: new Array<number>(d.slots.length).fill(0) };
        acc.set(d.name, a);
      }
      a.reads += d.reads;
      a.writes += d.writes;
      a.readBytes += d.readBytes;
      a.writeBytes += d.writeBytes;
      a.errors += d.errors;
      a.maxNs = Math.max(a.maxNs, d.latMaxNs);
      a.seconds++;
      d.slots.forEach((c, i) => { a!.slots[i] = (a!.slots[i] ?? 0) + c; });
    }
  }
  return [...acc.values()]
    .map(({ slots, ...r }) => ({ ...r, p99: percentile(slots, 0.99) }))
    .sort((a, b) => b.reads + b.writes - (a.reads + a.writes));
}

export type IssuerRow = {
  comm: string;
  procs: number;
  ios: number;
  readBytes: number;
  writeBytes: number;
  totalNs: number;
  maxNs: number;
  p99: number | null;
};

// Who issued the I/O in the visible range (most bytes first). Buffered writes are issued by kernel writeback
// threads (kworker), so they appear under that name rather than the process that wrote
export function issuerRows(samples: Sample[]): IssuerRow[] {
  const acc = new Map<string, IssuerRow & { slots: number[] }>();
  for (const s of samples) {
    if (!s.disk) continue;
    for (const p of s.procs ?? []) {
      let a = acc.get(p.comm);
      if (!a) {
        a = { comm: p.comm, procs: 0, ios: 0, readBytes: 0, writeBytes: 0, totalNs: 0, maxNs: 0, p99: null, slots: new Array<number>(p.slots.length).fill(0) };
        acc.set(p.comm, a);
      }
      a.procs = Math.max(a.procs, p.procs);
      a.ios += p.waitCount;
      a.readBytes += p.readBytes ?? 0;
      a.writeBytes += p.writeBytes ?? 0;
      a.totalNs += p.waitNs;
      a.maxNs = Math.max(a.maxNs, p.waitMaxNs);
      p.slots.forEach((c, i) => { a!.slots[i] = (a!.slots[i] ?? 0) + c; });
    }
  }
  return [...acc.values()]
    .map(({ slots, ...r }) => ({ ...r, p99: percentile(slots, 0.99) }))
    .sort((a, b) => b.readBytes + b.writeBytes - (a.readBytes + a.writeBytes));
}

export const formatRate = (bytesPerSec: number | null) =>
  bytesPerSec == null ? "–" : bytesPerSec < 1e6 ? `${Math.round(bytesPerSec / 1e3)} kB/s` : bytesPerSec < 1e9 ? `${(bytesPerSec / 1e6).toFixed(0)} MB/s` : `${(bytesPerSec / 1e9).toFixed(2)} GB/s`;

// One-line sentence for the summary. `level` is the disk area's level from the server's incidents
export function diskSentence(samples: Sample[], lang: Lang, level: Level): string {
  const tr = (k: Key, p?: Params) => translate(lang, k, p);
  const now = currentDisk(samples);
  if (!now.has) return tr("disk.summary.none");
  const state = tr("disk.summary.state", { p99: formatUs(now.p99), rate: formatRate(now.bytesPerSec), iops: Math.round(now.iops ?? 0) });
  const top = issuerRows(samples.slice(-CURRENT_WINDOW))[0];
  const who = top && top.readBytes + top.writeBytes > 0
    ? tr("disk.summary.issuer", { comm: top.procs > 1 ? tr("cause.who", { comm: top.comm, n: top.procs }) : top.comm, bytes: formatBytes(top.readBytes + top.writeBytes) })
    : "";
  const errors = now.errors > 0 ? ` ${tr("disk.summary.errors", { n: now.errors })}` : "";
  if (level !== "ok") return `${tr("disk.summary.slow", { p99: formatUs(now.p99) })} ${who}${errors}`.trim();
  return `${state} ${who}${errors}`.trim();
}

export const devLabel = (d: DiskDev) => d.name;
