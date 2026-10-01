// Pure helpers over the incidents the server emits (see /api/incidents and the SSE "incident" event).
// The judgement itself (thresholds, minimum duration, escalation) lives in the Go server; this file only reads it.
import type { Incident } from "../types/model";
import type { Level } from "./lens";
import type { Key } from "./i18n";

export type IncidentKind = "cpu_wait" | "vm_cpu_wait" | "mem_stall" | "oom_kill" | "crash" | "crash_loop" | "agent_down" | "vm_down" | "gpu_starved" | "vram_full" | "disk_slow" | "disk_error" | "net_connect_fail" | "net_connect_slow" | "net_retrans" | "net_drop" | "dns_fail" | "dns_slow" | "file_fail" | "fsync_slow" | "lock_wait";

// Instant incidents (an OOM kill, a crash) have no duration, so they keep an area at their level for this long afterwards
const INSTANT_LINGER_MS = 5 * 60 * 1000;
const INSTANT_KINDS = new Set<string>(["oom_kill", "crash", "crash_loop", "vm_down", "disk_error"]);

const RANK: Record<Level, number> = { ok: 0, caution: 1, warning: 2 };

export const isOngoing = (x: Incident) => !x.end;
export const isInstantKind = (kind: string) => kind === "oom_kill" || kind === "crash" || kind === "vm_down" || kind === "disk_error";

// Whether an incident still counts toward the current status.
// cpu_wait / vm_cpu_wait / mem_stall / agent_down: only while ongoing. oom_kill / crash / crash_loop / vm_down: also for 5 minutes after they ended
export function isActive(x: Incident, nowMs: number): boolean {
  if (isOngoing(x)) return true;
  if (!INSTANT_KINDS.has(x.kind)) return false;
  return nowMs - Date.parse(x.end!) <= INSTANT_LINGER_MS;
}

// Worst level among the active incidents of the given kinds
export function areaLevel(incidents: Incident[], kinds: readonly string[], nowMs: number): Level {
  let level: Level = "ok";
  for (const x of incidents) {
    if (!kinds.includes(x.kind) || !isActive(x, nowMs)) continue;
    const l = asLevel(x.level);
    if (RANK[l] > RANK[level]) level = l;
  }
  return level;
}

// Newest incident of a kind (the list is kept newest first, so this is the first match)
export function latestOf(incidents: Incident[], kind: IncidentKind): Incident | undefined {
  return incidents.find((x) => x.kind === kind);
}

export function asLevel(s: string): Level {
  return s === "warning" ? "warning" : s === "caution" ? "caution" : "ok";
}

const KIND_KEY: Record<IncidentKind, Key> = {
  cpu_wait: "incident.kind.cpu_wait",
  vm_cpu_wait: "incident.kind.vm_cpu_wait",
  mem_stall: "incident.kind.mem_stall",
  oom_kill: "incident.kind.oom_kill",
  crash: "incident.kind.crash",
  crash_loop: "incident.kind.crash_loop",
  agent_down: "incident.kind.agent_down",
  vm_down: "incident.kind.vm_down",
  gpu_starved: "incident.kind.gpu_starved",
  vram_full: "incident.kind.vram_full",
  disk_slow: "incident.kind.disk_slow",
  disk_error: "incident.kind.disk_error",
  net_connect_fail: "incident.kind.net_connect_fail",
  net_connect_slow: "incident.kind.net_connect_slow",
  net_retrans: "incident.kind.net_retrans",
  net_drop: "incident.kind.net_drop",
  dns_fail: "incident.kind.dns_fail",
  dns_slow: "incident.kind.dns_slow",
  file_fail: "incident.kind.file_fail",
  fsync_slow: "incident.kind.fsync_slow",
  lock_wait: "incident.kind.lock_wait",
};

// Translation key for a kind label (unknown kinds from a newer server fall back to a generic label)
export function kindKey(kind: string): Key {
  return KIND_KEY[kind as IncidentKind] ?? "incident.kind.other";
}

// Newest first; among incidents that started at the same time, ongoing ones come first
export function sortIncidents(xs: Incident[]): Incident[] {
  return [...xs].sort((a, b) => {
    const d = Date.parse(b.start) - Date.parse(a.start);
    if (d !== 0) return d;
    return Number(isOngoing(b)) - Number(isOngoing(a));
  });
}

// Seconds the incident has lasted so far (instant incidents have none)
export function durationSeconds(x: Incident, nowMs: number): number | null {
  if (isInstantKind(x.kind)) return null;
  if (x.seconds > 0) return x.seconds;
  const end = x.end ? Date.parse(x.end) : nowMs;
  return Math.max(0, Math.round((end - Date.parse(x.start)) / 1000));
}
