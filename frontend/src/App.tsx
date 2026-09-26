import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { HostInfo } from "./types/model";
import { useLiveHost, type StreamStatus } from "./lib/useLiveHost";
import { analyze } from "./lib/lifecycle";
import { current, type Level } from "./lib/lens";
import { useColorSchemeKey } from "./lib/theme";
import { timeWindow } from "./lib/timeWindow";
import { Link, ROUTES, usePath } from "./lib/router";
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
  const [navOpen, setNavOpen] = useState(false);
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
    <div>
      {/* 上部バー(OpenSearch Dashboards 風): ☰ / ホーム / パンくず、右端にホストと受信状態 */}
      <header
        className="sticky top-0 z-40 flex h-12 items-center"
        style={{ background: "var(--surface-1)", borderBottom: "1px solid var(--border)" }}
      >
        <MenuButton open={navOpen} onToggle={() => setNavOpen((v) => !v)} />
        <Link
          to="/"
          onNavigate={closeNav}
          aria-label="ダッシュボードへ"
          className="flex h-12 w-12 items-center justify-center hover:bg-[var(--page)]"
          style={{ borderRight: "1px solid var(--border)" }}
        >
          <HomeIcon />
        </Link>
        <span
          className="ml-3 min-w-0 truncate rounded px-3 py-0.5 text-sm"
          style={{ background: "var(--page)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
        >
          {title}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2 pr-3 pl-2 sm:gap-3">
          <select
            className="max-w-[8.5rem] rounded-md px-2 py-1 text-sm sm:max-w-none"
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
        </div>
      </header>
      <Nav path={path} open={navOpen} onClose={closeNav} levels={levels} />

      <main className="mx-auto max-w-6xl px-4 py-6">
        {/* 画面名は上部バーのパンくずで見せるので、見出しは読み上げ用だけにする */}
        <h1 className="sr-only">{title}</h1>
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
      </main>
    </div>
  );
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M2.5 7.5 8 3l5.5 4.5V13a.5.5 0 0 1-.5.5H9.5V10h-3v3.5H3a.5.5 0 0 1-.5-.5z" />
    </svg>
  );
}

function StatusBadge({ status }: { status: StreamStatus }) {
  const live = status === "live";
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
      <span aria-hidden style={{ color: live ? "var(--status-good)" : "var(--status-critical)" }}>
        {live ? "●" : "○"}
      </span>
      {/* 狭い画面では記号だけにする(読み上げ用の文字は残す) */}
      <span className="sr-only sm:not-sr-only">{live ? "ライブ" : status === "connecting" ? "接続中" : "再接続中"}</span>
    </span>
  );
}
