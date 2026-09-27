// The thresholds the server judges with (GET /api/triggers). Charts draw their bands from these so the UI never
// disagrees with the server. The defaults below match the server defaults and are used until the fetch returns
import { useQuery } from "@tanstack/react-query";

export type ExcursionRule = { caution: number; warning: number; minSeconds: number; maxGapSeconds: number };

export type Triggers = {
  cpu: ExcursionRule; // run-queue latency p99, in µs
  memory: ExcursionRule; // time stalled in reclaim, in ms per second
  processes: { crashLoopCount: number; crashLoopWindowSeconds: number };
  agentDown: { afterSeconds: number };
};

export const DEFAULT_TRIGGERS: Triggers = {
  cpu: { caution: 1_000, warning: 10_000, minSeconds: 3, maxGapSeconds: 2 },
  memory: { caution: 10, warning: 100, minSeconds: 3, maxGapSeconds: 2 },
  processes: { crashLoopCount: 3, crashLoopWindowSeconds: 300 },
  agentDown: { afterSeconds: 30 },
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
  };
}
