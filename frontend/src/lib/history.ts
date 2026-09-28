// The past, from the server's DB (GET /api/history, /api/history/events): bucketed samples for the history
// timeline, and one-second samples around a moment for the per-area screens ("?at=<unix ms>").
import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ProcEvent, Sample } from "../types/model";
import type { TimeWindow } from "./timeWindow";

export const PAST_HALF_WINDOW_MS = 150_000; // a past moment is shown with 2.5 minutes on each side (the live screens show 5 minutes)

const subscribe = (cb: () => void) => {
  window.addEventListener("popstate", cb);
  return () => window.removeEventListener("popstate", cb);
};

// The moment the per-area screens should show instead of live data, from "?at=<unix ms>"; null when live
export function useAt(): number | null {
  const search = useSyncExternalStore(subscribe, () => window.location.search);
  const v = Number(new URLSearchParams(search).get("at"));
  return Number.isFinite(v) && v > 0 ? v : null;
}

async function fetchJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${(await r.text()).trim()}`);
  return r.json() as Promise<T>;
}

async function fetchProbes(host: string, probes: readonly string[], fromMs: number, toMs: number, bucketSec: number) {
  const entries = await Promise.all(
    probes.map(async (p) => {
      const q = new URLSearchParams({ host, probe: p, from: String(Math.round(fromMs)), to: String(Math.round(toMs)), bucket: String(bucketSec) });
      return [p, await fetchJSON<Sample[]>(`/api/history?${q}`)] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<string, Sample[]>;
}

// Bucketed samples of every probe over [from, to]; refreshed once a minute while the range ends near now
export function useHistoryRange(host: string | undefined, probes: readonly string[], fromMs: number, toMs: number, bucketSec: number) {
  return useQuery({
    queryKey: ["history", host, probes, Math.round(fromMs / 60_000), Math.round(toMs / 60_000), bucketSec],
    queryFn: () => fetchProbes(host!, probes, fromMs, toMs, bucketSec),
    enabled: !!host,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

export type PastWindow = { active: boolean; byProbe: Record<string, Sample[]>; events: ProcEvent[]; win: TimeWindow; loading: boolean };

const EMPTY_PAST: Record<string, Sample[]> = {};
const NO_EVENTS: ProcEvent[] = [];

// One-second samples and the process events of the 5 minutes around `at` (null: not in the past)
export function useHistoryWindow(host: string | undefined, at: number | null, probes: readonly string[]): PastWindow {
  const fromMs = (at ?? 0) - PAST_HALF_WINDOW_MS;
  const toMs = (at ?? 0) + PAST_HALF_WINDOW_MS;
  const q = useQuery({
    queryKey: ["history-window", host, probes, at],
    queryFn: async () => {
      const [byProbe, events] = await Promise.all([
        fetchProbes(host!, probes, fromMs, toMs, 1),
        fetchJSON<ProcEvent[]>(`/api/history/events?${new URLSearchParams({ host: host!, from: String(Math.round(fromMs)), to: String(Math.round(toMs)) })}`),
      ]);
      return { byProbe, events };
    },
    enabled: !!host && at != null,
    staleTime: Infinity, // the past does not change
  });
  return {
    active: at != null,
    byProbe: q.data?.byProbe ?? EMPTY_PAST,
    events: q.data?.events ?? NO_EVENTS,
    win: { startMs: fromMs, endMs: toMs },
    loading: q.isLoading,
  };
}
