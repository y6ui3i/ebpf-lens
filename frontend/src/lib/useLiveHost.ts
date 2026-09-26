import { useEffect, useState } from "react";
import type { EventBatch, ProcEvent, Sample } from "../types/model";

export type StreamStatus = "connecting" | "live" | "reconnecting";

const EVENT_WINDOW_MS = 5 * 60 * 1000;
const MAX_EVENTS = 20000;

// 1 本の SSE でサンプルとイベントの新着を受け、履歴と合わせて保持する。
// 取りこぼしを防ぐため、履歴の取得より先に SSE を開く。
export function useLiveHost(host: string | undefined, probe: string, limit: number) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [events, setEvents] = useState<ProcEvent[]>([]);
  const [dropped, setDropped] = useState(0);
  const [status, setStatus] = useState<StreamStatus>("connecting");

  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    setSamples([]);
    setEvents([]);
    setDropped(0);
    setStatus("connecting");

    const es = new EventSource(`/api/stream?host=${encodeURIComponent(host)}`);
    es.onopen = () => setStatus("live");
    es.onerror = () => setStatus("reconnecting"); // EventSource は自動で再接続する
    es.addEventListener("sample", (ev) => {
      const s = JSON.parse((ev as MessageEvent<string>).data) as Sample;
      if (s.probe !== probe) return;
      setSamples((prev) => [...prev, s].slice(-limit));
    });
    es.addEventListener("events", (ev) => {
      const b = JSON.parse((ev as MessageEvent<string>).data) as EventBatch;
      setEvents((prev) => trim([...prev, ...(b.events ?? [])]));
      if (b.dropped) setDropped((d) => d + b.dropped);
    });

    const q = `host=${encodeURIComponent(host)}`;
    fetch(`/api/samples?${q}&probe=${encodeURIComponent(probe)}`)
      .then((r) => r.json() as Promise<Sample[] | null>)
      .then((h) => {
        const history = h ?? [];
        if (cancelled) return;
        setSamples((live) => [...history, ...newerThan(live, history.at(-1)?.time)].slice(-limit));
      })
      .catch(() => {});
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
  }, [host, probe, limit]);

  return { samples, events, dropped, status };
}

function newerThan<T extends { time: string }>(xs: T[], last: string | undefined): T[] {
  const lastMs = last ? Date.parse(last) : -Infinity;
  return xs.filter((x) => Date.parse(x.time) > lastMs);
}

// 直近 5 分・最大件数に切り詰める
function trim(xs: ProcEvent[]): ProcEvent[] {
  const last = xs.at(-1);
  if (!last) return xs;
  const from = Date.parse(last.time) - EVENT_WINDOW_MS;
  let i = 0;
  while (i < xs.length && Date.parse(xs[i].time) < from) i++;
  return xs.slice(Math.max(i, xs.length - MAX_EVENTS));
}
