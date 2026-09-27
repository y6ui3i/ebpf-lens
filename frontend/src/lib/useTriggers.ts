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
  };
}
