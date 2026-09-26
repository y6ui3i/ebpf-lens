import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { HostInfo } from "./types/model";
import { useLiveHost, type StreamStatus } from "./lib/useLiveHost";
import { analyze } from "./lib/lifecycle";
import { current, type Level } from "./lib/lens";
import { useColorSchemeKey } from "./lib/theme";
import { timeWindow } from "./lib/timeWindow";
import { ROUTES, usePath } from "./lib/router";
import { MenuButton, Nav } from "./components/Nav";
import { LensSummary } from "./components/LensSummary";
import { UseMatrix } from "./components/UseMatrix";
import { ImpactPanel } from "./components/ImpactPanel";
import { CpuLatencyCard } from "./components/CpuLatencyCard";
import { LifecyclePanel } from "./components/LifecyclePanel";

const WINDOW = 300; // 直近 5 分(1 秒 1 列)
const RANK: Record<Level, number> = { ok: 0, caution: 1, warning: 2 };
const worst = (a: Level, b: Level) => (RANK[a] >= RANK[b] ? a : b);

export default function App() {
  const path = usePath();
  const schemeKey = useColorSchemeKey();
  const [navOpen, setNavOpen] = useState(false); // 狭い画面のドロワーだけ。広い画面では常設

  const closeNav = useCallback(() => setNavOpen(false), []);

  const hosts = useQuery({
    queryKey: ["hosts"],
    queryFn: () => fetch("/api/hosts").then((r) => r.json() as Promise<HostInfo[]>),
    refetchInterval: 5000,
  });
  const [picked, setPicked] = useState<string>();
  const host = picked ?? hosts.data?.[0]?.name;
  // 受信は画面の外側で続ける。画面を切り替えてもライブ表示が途切れない
  const { samples, events, dropped, status } = useLiveHost(host, "runqlat", WINDOW);
  const life = useMemo(() => analyze(events), [events]);
  const win = useMemo(() => timeWindow(samples, WINDOW), [samples]);
  const cpuLevel = current(samples).level;
  const levels = { "/": worst(cpuLevel, life.level), "/cpu": cpuLevel, "/processes": life.level };
  const title = ROUTES.find((r) => r.path === path)?.label ?? "";

  return (
    <div className="lg:flex">
      <Nav path={path} open={navOpen} onClose={closeNav} levels={levels} />
      <div className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl px-4 py-6">
          <header className="mb-6 flex flex-wrap items-center gap-3">
            <MenuButton open={navOpen} onToggle={() => setNavOpen((v) => !v)} />
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            <select
              className="rounded-md px-2 py-1 text-sm"
              style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
              value={host ?? ""}
              onChange={(e) => setPicked(e.target.value)}
              aria-label="ホスト"
            >
              {hosts.data?.length ? null : <option value="">ホストなし</option>}
              {hosts.data?.map((h) => (
                <option key={h.name} value={h.name}>{h.name}</option>
              ))}
            </select>
            {host && <StatusBadge status={status} />}
          </header>

          {!host ? (
            <p style={{ color: "var(--text-secondary)" }}>
              エージェントからのデータを待っています。<code>ebpflens-agent -server …</code> を起動してください。
            </p>
          ) : path === "/cpu" ? (
            <>
              <CpuLatencyCard samples={samples} win={win} schemeKey={schemeKey} />
              <div className="mt-6"><ImpactPanel samples={samples} /></div>
            </>
          ) : path === "/processes" ? (
            <LifecyclePanel events={events} life={life} dropped={dropped} />
          ) : (
            <>
              <LensSummary samples={samples} life={life} />
              <UseMatrix samples={samples} events={events} life={life} win={win} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: StreamStatus }) {
  const live = status === "live";
  return (
    <span className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
      <span aria-hidden style={{ color: live ? "var(--status-good)" : "var(--status-critical)" }}>
        {live ? "●" : "○"}
      </span>
      {live ? "ライブ" : status === "connecting" ? "接続中" : "再接続中"}
    </span>
  );
}
