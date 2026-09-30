// The thresholds the server judges with (GET /api/triggers). Charts draw their bands from these so the UI never
// disagrees with the server. The defaults below match the server defaults and are used until the fetch returns
import { useQuery } from "@tanstack/react-query";

export type ExcursionRule = { caution: number; warning: number; minSeconds: number; maxGapSeconds: number };

export type Triggers = {
  cpu: ExcursionRule; // run-queue latency p99, in µs
  memory: ExcursionRule; // time stalled in reclaim, in ms per second
  processes: { crashLoopCount: number; crashLoopWindowSeconds: number };
  agentDown: { afterSeconds: number };
  gpu: { idleUtil: number; starved: ExcursionRule; vram: ExcursionRule }; // shares 0..1
  disk: ExcursionRule; // block I/O latency p99, in µs
  network: { connectFails: ExcursionRule; failSpreadSeconds: number; connectLatency: ExcursionRule; retrans: ExcursionRule; drops: ExcursionRule }; // failed connects in 10 s (in at least failSpreadSeconds of them), µs, per second, trouble drops in 10 s
  dns: { fails: ExcursionRule; failSpreadSeconds: number; latency: ExcursionRule }; // failed lookups in 10 s; getaddrinfo p99 in µs
};

export const DEFAULT_TRIGGERS: Triggers = {
  cpu: { caution: 1_000, warning: 10_000, minSeconds: 3, maxGapSeconds: 2 },
  memory: { caution: 10, warning: 100, minSeconds: 3, maxGapSeconds: 2 },
  processes: { crashLoopCount: 3, crashLoopWindowSeconds: 300 },
  agentDown: { afterSeconds: 30 },
  gpu: {
    idleUtil: 0.2,
    starved: { caution: 0.5, warning: 0.9, minSeconds: 10, maxGapSeconds: 5 },
    vram: { caution: 0.9, warning: 0.97, minSeconds: 3, maxGapSeconds: 2 },
  },
  disk: { caution: 10_000, warning: 100_000, minSeconds: 3, maxGapSeconds: 2 },
  network: {
    connectFails: { caution: 5, warning: 50, minSeconds: 1, maxGapSeconds: 10 }, // failed connects in the last 10 s
    failSpreadSeconds: 3,
    connectLatency: { caution: 200_000, warning: 1_000_000, minSeconds: 3, maxGapSeconds: 5 },
    retrans: { caution: 10, warning: 100, minSeconds: 3, maxGapSeconds: 5 },
    drops: { caution: 10, warning: 100, minSeconds: 1, maxGapSeconds: 10 }, // packets dropped for a trouble reason in the last 10 s
  },
  dns: {
    fails: { caution: 5, warning: 50, minSeconds: 1, maxGapSeconds: 10 },
    failSpreadSeconds: 3,
    latency: { caution: 100_000, warning: 1_000_000, minSeconds: 3, maxGapSeconds: 5 },
  },
};

export function useTriggers(): Triggers {
  const q = useQuery({
    queryKey: ["triggers"],
    queryFn: () => fetch("/api/triggers").then((r) => r.json() as Promise<Partial<Triggers>>),
    staleTime: 5 * 60 * 1000,
  });
  const d = q.data;
  if (!d) return DEFAULT_TRIGGERS;
  return {
    cpu: { ...DEFAULT_TRIGGERS.cpu, ...d.cpu },
    memory: { ...DEFAULT_TRIGGERS.memory, ...d.memory },
    processes: { ...DEFAULT_TRIGGERS.processes, ...d.processes },
    agentDown: { ...DEFAULT_TRIGGERS.agentDown, ...d.agentDown },
    gpu: {
      idleUtil: d.gpu?.idleUtil ?? DEFAULT_TRIGGERS.gpu.idleUtil,
      starved: { ...DEFAULT_TRIGGERS.gpu.starved, ...d.gpu?.starved },
      vram: { ...DEFAULT_TRIGGERS.gpu.vram, ...d.gpu?.vram },
    },
    disk: { ...DEFAULT_TRIGGERS.disk, ...d.disk },
    network: {
      connectFails: { ...DEFAULT_TRIGGERS.network.connectFails, ...d.network?.connectFails },
      failSpreadSeconds: d.network?.failSpreadSeconds ?? DEFAULT_TRIGGERS.network.failSpreadSeconds,
      connectLatency: { ...DEFAULT_TRIGGERS.network.connectLatency, ...d.network?.connectLatency },
      retrans: { ...DEFAULT_TRIGGERS.network.retrans, ...d.network?.retrans },
      drops: { ...DEFAULT_TRIGGERS.network.drops, ...d.network?.drops },
    },
    dns: {
      fails: { ...DEFAULT_TRIGGERS.dns.fails, ...d.dns?.fails },
      failSpreadSeconds: d.dns?.failSpreadSeconds ?? DEFAULT_TRIGGERS.dns.failSpreadSeconds,
      latency: { ...DEFAULT_TRIGGERS.dns.latency, ...d.dns?.latency },
    },
  };
}
