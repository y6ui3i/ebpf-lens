import { useEffect, useState } from "react";
import type { Sample } from "../types/model";

export type StreamStatus = "connecting" | "live" | "reconnecting";

// 履歴を取得したうえで、SSE の新着を末尾に足していく。
// 取りこぼしを防ぐため、履歴の取得より先に SSE を開く。
export function useLiveSamples(host: string | undefined, probe: string, limit: number) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [status, setStatus] = useState<StreamStatus>("connecting");

  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    setSamples([]);
    setStatus("connecting");

    const es = new EventSource(`/api/stream?host=${encodeURIComponent(host)}`);
    es.onopen = () => setStatus("live");
    es.onerror = () => setStatus("reconnecting"); // EventSource は自動で再接続する
    es.addEventListener("sample", (ev) => {
      const s = JSON.parse((ev as MessageEvent<string>).data) as Sample;
      if (s.probe !== probe) return;
      setSamples((prev) => [...prev, s].slice(-limit));
    });

    fetch(`/api/samples?host=${encodeURIComponent(host)}&probe=${encodeURIComponent(probe)}`)
      .then((r) => r.json() as Promise<Sample[]>)
      .then((history) => {
        if (cancelled) return;
        setSamples((live) => {
          const last = history.at(-1);
          const lastMs = last ? Date.parse(last.time) : -Infinity;
          const newer = live.filter((s) => Date.parse(s.time) > lastMs);
          return [...history, ...newer].slice(-limit);
        });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      es.close();
    };
  }, [host, probe, limit]);

  return { samples, status };
}
