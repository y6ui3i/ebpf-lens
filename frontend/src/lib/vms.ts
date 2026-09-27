// Turns the "vms" probe, the per-process runqlat / memstall stats and the VM incidents (vm_down, vm_cpu_wait) into per-VM views.
// Whether a VM stop or its CPU wait is "bad" is judged by the server; this file only reads and aggregates.
import type { Incident, ProcStat, Sample, VMInfo } from "../types/model";
import { percentile } from "./hist";
import { areaLevel, isOngoing } from "./incidents";
import type { Level } from "./lens";

const SLOTS = 27; // log2 histogram size the agent sends (µs, 2^0 .. 2^26)
const RECENT = 5; // seconds used for the "current" numbers in the list and the USE row
const DAY_MS = 24 * 60 * 60 * 1000;
// Incident kinds that belong to a VM. The area level of the VM group (dashboard, nav, USE row) is judged over VM_AREA_KINDS
const VM_KINDS = ["vm_down", "oom_kill", "vm_cpu_wait"] as const;
export const VM_AREA_KINDS = ["vm_down", "vm_cpu_wait"] as const;

// A VM's QEMU process is filed under this comm in runqlat / memstall
export const vmComm = (name: string) => `vm:${name}`;

export type VmState = {
  name: string;
  running: boolean;
  info?: VMInfo; // present while running
  lastDown?: Incident; // latest vm_down of this VM within the kept 24 h
  cpuWait?: Incident; // ongoing vm_cpu_wait of this VM (it is waiting for host CPU right now)
  level: Level; // worst level of this VM's incidents that still count (vm_down lingers 5 minutes, vm_cpu_wait while ongoing)
  incidents: Incident[]; // vm_down / oom_kill / vm_cpu_wait of this VM, newest first
};

// The VMs on the host right now (from the latest "vms" sample). undefined when no vms sample has arrived yet
export function runningVms(vmSamples: Sample[]): VMInfo[] | undefined {
  const last = vmSamples.at(-1);
  return last ? (last.vms ?? []) : undefined;
}

export const runningCounts = (vmSamples: Sample[]): number[] => vmSamples.map((s) => s.vms?.length ?? 0);

// Incidents that belong to a VM: its vm_down, OOM kills of its QEMU process, and its own host-side CPU wait. The input is newest first
export function vmIncidents(incidents: Incident[], name: string): Incident[] {
  return incidents.filter((x) => x.vm === name && (VM_KINDS as readonly string[]).includes(x.kind));
}

export const latestVmDown = (incidents: Incident[], name: string): Incident | undefined =>
  incidents.find((x) => x.kind === "vm_down" && x.vm === name);

// Latest vm_cpu_wait of a VM (ongoing or ended) within the kept 24 h
export const latestVmCpuWait = (incidents: Incident[], name: string): Incident | undefined =>
  incidents.find((x) => x.kind === "vm_cpu_wait" && x.vm === name);

// VMs waiting for host CPU right now (one ongoing vm_cpu_wait per VM), worst peak first
export function vmsWaitingForCpu(incidents: Incident[]): Incident[] {
  return incidents
    .filter((x) => x.kind === "vm_cpu_wait" && isOngoing(x))
    .sort((a, b) => (b.peak ?? 0) - (a.peak ?? 0));
}

// VM stops in the last 24 h (across all VMs), newest first
export function vmStopsWithin(incidents: Incident[], nowMs: number, ms = DAY_MS): Incident[] {
  return incidents.filter((x) => x.kind === "vm_down" && nowMs - Date.parse(x.start) <= ms);
}

// Known VMs = running now ∪ any VM with an incident in the last 24 h.
// Order: VMs with an active incident first, then running, then stopped; by name within each group
export function knownVms(vmSamples: Sample[], incidents: Incident[], nowMs: number): VmState[] {
  const names = new Set<string>();
  const running = new Map<string, VMInfo>();
  for (const v of runningVms(vmSamples) ?? []) {
    running.set(v.name, v);
    names.add(v.name);
  }
  for (const x of incidents) {
    if (x.vm && (VM_KINDS as readonly string[]).includes(x.kind) && nowMs - Date.parse(x.start) <= DAY_MS) names.add(x.vm);
  }
  const out: VmState[] = [...names].map((name) => vmState(name, running.get(name), incidents, nowMs));
  const rank = (v: VmState) => (v.level !== "ok" ? 0 : v.running ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function vmState(name: string, info: VMInfo | undefined, incidents: Incident[], nowMs: number): VmState {
  const own = vmIncidents(incidents, name);
  return {
    name,
    running: info != null,
    info,
    lastDown: own.find((x) => x.kind === "vm_down"),
    cpuWait: own.find((x) => x.kind === "vm_cpu_wait" && isOngoing(x)),
    level: areaLevel(own, VM_KINDS, nowMs),
    incidents: own,
  };
}

export const vmProc = (s: Sample, name: string): ProcStat | undefined =>
  s.procs?.find((p) => p.comm === vmComm(name));

// Merged wait histogram of the VM over the last n samples (runqlat). null when the VM never appeared in them
export function vmWaitP99(samples: Sample[], name: string, n = RECENT): number | null {
  const merged = new Array<number>(SLOTS).fill(0);
  let seen = false;
  for (const s of samples.slice(-n)) {
    const p = vmProc(s, name);
    if (!p) continue;
    seen = true;
    p.slots.forEach((c, i) => {
      if (i < SLOTS) merged[i] += c;
    });
  }
  return seen ? percentile(merged, 0.99) : null;
}

// Share of the whole host's CPU capacity used by the VM over the last n samples (0..1)
export function vmCpuShare(samples: Sample[], name: string, n = RECENT): number | null {
  let on = 0;
  let cap = 0;
  for (const s of samples.slice(-n)) {
    if (!(s.cpus > 0 && s.intervalMs > 0)) continue;
    cap += s.intervalMs * 1e6 * s.cpus;
    on += vmProc(s, name)?.onCpuNs ?? 0;
  }
  return cap > 0 ? Math.min(1, on / cap) : null;
}

// Time the VM's QEMU process was stalled in memory reclaim, in ms per second, over the last n memstall samples.
// 0 when memstall samples exist but the VM did not stall; null when there are no memstall samples
export function vmStallMsPerSec(memSamples: Sample[], name: string, n = RECENT): number | null {
  let stalledNs = 0;
  let ms = 0;
  for (const s of memSamples.slice(-n)) {
    if (!(s.intervalMs > 0)) continue;
    ms += s.intervalMs;
    stalledNs += vmProc(s, name)?.waitNs ?? 0;
  }
  return ms > 0 ? stalledNs / 1e6 / (ms / 1000) : null;
}

// Per-second reclaim stall of the VM (ms/s), aligned with memSamples, for a trend line
export const vmStallSeries = (memSamples: Sample[], name: string): (number | null)[] =>
  memSamples.map((s) => (s.intervalMs > 0 ? (vmProc(s, name)?.waitNs ?? 0) / 1e6 / (s.intervalMs / 1000) : null));

// Pseudo-samples whose histogram is the VM's own wait histogram, so the host charts (Heatmap, PercentileChart)
// can be reused unchanged. Seconds where the VM's process is absent get an empty histogram
export function vmPseudoSamples(samples: Sample[], name: string): Sample[] {
  const zeros = new Array<number>(SLOTS).fill(0);
  return samples.map((s) => ({ ...s, slots: vmProc(s, name)?.slots ?? zeros }));
}

// Level of a number against caution / warning thresholds (same numbers the server judges with)
export function levelFor(v: number | null, caution: number, warning: number): Level {
  if (v == null) return "ok";
  return v >= warning ? "warning" : v >= caution ? "caution" : "ok";
}
