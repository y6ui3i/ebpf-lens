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
  network: { connectFails: ExcursionRule; connectLatency: ExcursionRule; retrans: ExcursionRule }; // per second, µs, per second
  dns: { fails: ExcursionRule; latency: ExcursionRule }; // failed lookups in 10 s; getaddrinfo p99 in µs
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
    connectLatency: { caution: 200_000, warning: 1_000_000, minSeconds: 3, maxGapSeconds: 5 },
    retrans: { caution: 10, warning: 100, minSeconds: 3, maxGapSeconds: 5 },
  },
  dns: {
    fails: { caution: 5, warning: 50, minSeconds: 1, maxGapSeconds: 10 },
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
      connectLatency: { ...DEFAULT_TRIGGERS.network.connectLatency, ...d.network?.connectLatency },
      retrans: { ...DEFAULT_TRIGGERS.network.retrans, ...d.network?.retrans },
    },
    dns: {
      fails: { ...DEFAULT_TRIGGERS.dns.fails, ...d.dns?.fails },
      latency: { ...DEFAULT_TRIGGERS.dns.latency, ...d.dns?.latency },
    },
  };
}
