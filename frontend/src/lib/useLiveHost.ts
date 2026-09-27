import { useEffect, useMemo, useState } from "react";
import type { EventBatch, Incident, ProcEvent, Sample } from "../types/model";
import { isOngoing, sortIncidents } from "./incidents";

export type StreamStatus = "connecting" | "live" | "reconnecting";

const EVENT_WINDOW_MS = 5 * 60 * 1000;
const MAX_EVENTS = 20000;
const INCIDENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_INCIDENTS = 500;

type ByProbe = Record<string, Sample[]>;
type ById = Record<string, Incident>;

// Receives new samples (per probe), events and incidents over a single SSE stream and keeps them merged with history.
// The SSE stream is opened before fetching history so nothing is missed. Callers must pass a stable `probes` array
export function useLiveHost(host: string | undefined, probes: readonly string[], limit: number) {
  const [samples, setSamples] = useState<ByProbe>({});
  const [events, setEvents] = useState<ProcEvent[]>([]);
  const [incidentsById, setIncidentsById] = useState<ById>({});
  const [dropped, setDropped] = useState(0);
  const [status, setStatus] = useState<StreamStatus>("connecting");

  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    setSamples({});
    setEvents([]);
    setIncidentsById({});
    setDropped(0);
    setStatus("connecting");

    const q = `host=${encodeURIComponent(host)}`;

    // Incidents are keyed by id: the same id arrives repeatedly as it progresses, so history and live updates just merge
    const loadIncidents = () =>
      fetch(`/api/incidents?${q}`)
        .then((r) => r.json() as Promise<Incident[] | null>)
        .then((h) => {
          if (cancelled) return;
          setIncidentsById((prev) => upsert(prev, h ?? []));
        })
        .catch(() => {});

    const es = new EventSource(`/api/stream?${q}`);
    es.onopen = () => {
      setStatus("live");
      // Also runs on every automatic reconnect, so incidents that changed while disconnected are picked up
      loadIncidents();
    };
    es.onerror = () => setStatus("reconnecting"); // EventSource reconnects automatically
    es.addEventListener("sample", (ev) => {
      const s = JSON.parse((ev as MessageEvent<string>).data) as Sample;
      if (!probes.includes(s.probe)) return;
      setSamples((prev) => ({ ...prev, [s.probe]: [...(prev[s.probe] ?? []), s].slice(-limit) }));
    });
    es.addEventListener("events", (ev) => {
      const b = JSON.parse((ev as MessageEvent<string>).data) as EventBatch;
      setEvents((prev) => trim([...prev, ...(b.events ?? [])]));
      if (b.dropped) setDropped((d) => d + b.dropped);
    });
    es.addEventListener("incident", (ev) => {
      const x = JSON.parse((ev as MessageEvent<string>).data) as Incident;
      setIncidentsById((prev) => upsert(prev, [x]));
    });

    for (const probe of probes) {
      fetch(`/api/samples?${q}&probe=${encodeURIComponent(probe)}`)
        .then((r) => r.json() as Promise<Sample[] | null>)
        .then((h) => {
          const history = h ?? [];
          if (cancelled) return;
          setSamples((live) => ({
            ...live,
            [probe]: [...history, ...newerThan(live[probe] ?? [], history.at(-1)?.time)].slice(-limit),
          }));
        })
        .catch(() => {});
    }
    fetch(`/api/events?${q}`)
      .then((r) => r.json() as Promise<ProcEvent[] | null>)
      .then((h) => {
        const history = h ?? [];
        if (cancelled) return;
        setEvents((live) => trim([...history, ...newerThan(live, history.at(-1)?.time)]));
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      es.close();
    };
  }, [host, probes, limit]);

  // Newest first, ongoing first on ties
  const incidents = useMemo(() => sortIncidents(Object.values(incidentsById)), [incidentsById]);

  return { samples, events, incidents, dropped, status };
}

function newerThan<T extends { time: string }>(xs: T[], last: string | undefined): T[] {
  const lastMs = last ? Date.parse(last) : -Infinity;
  return xs.filter((x) => Date.parse(x.time) > lastMs);
}

// Trim to the last 5 minutes and the maximum count
function trim(xs: ProcEvent[]): ProcEvent[] {
  const last = xs.at(-1);
  if (!last) return xs;
  const from = Date.parse(last.time) - EVENT_WINDOW_MS;
  let i = 0;
  while (i < xs.length && Date.parse(xs[i].time) < from) i++;
  return xs.slice(Math.max(i, xs.length - MAX_EVENTS));
}

// Merge incidents by id, then bound the set to the last 24 hours and 500 entries (ongoing ones are always kept)
function upsert(prev: ById, xs: Incident[]): ById {
  if (xs.length === 0) return prev;
  const next: ById = { ...prev };
  for (const x of xs) {
    const old = next[x.id];
    // Ignore an update older than what we already have (history may arrive after a newer live update)
    if (old && Date.parse(old.updated) > Date.parse(x.updated)) continue;
    next[x.id] = x;
  }
  const all = sortIncidents(Object.values(next));
  const newest = all[0] ? Math.max(Date.now(), Date.parse(all[0].updated)) : Date.now();
  const from = newest - INCIDENT_WINDOW_MS;
  const kept = all.filter((x, i) => isOngoing(x) || (i < MAX_INCIDENTS && Date.parse(x.end ?? x.updated) >= from));
  if (kept.length === all.length) return next;
  return Object.fromEntries(kept.map((x) => [x.id, x]));
}
