import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { HostInfo } from "./types/model";
import { useLiveHost, type StreamStatus } from "./lib/useLiveHost";
import { analyze } from "./lib/lifecycle";
import type { Level } from "./lib/lens";
import { areaLevel } from "./lib/incidents";
import { useColorSchemeKey } from "./lib/theme";
import { timeWindow } from "./lib/timeWindow";
import { Link, matchRoute, usePath } from "./lib/router";
import { VM_AREA_KINDS, knownVms } from "./lib/vms";
import { useI18n, type Key, type Lang } from "./lib/i18n";
import { MenuButton, Nav, type NavVm } from "./components/Nav";
import { LensSummary } from "./components/LensSummary";
import { UseMatrix } from "./components/UseMatrix";
import { ImpactPanel } from "./components/ImpactPanel";
import { CpuLatencyCard } from "./components/CpuLatencyCard";
import { LifecyclePanel } from "./components/LifecyclePanel";
import { MemoryPanel } from "./components/MemoryPanel";
import { GpuPanel } from "./components/GpuPanel";
import { GPU_KINDS } from "./lib/gpu";
import { DiskPanel } from "./components/DiskPanel";
import { DISK_KINDS } from "./lib/disk";
import { VmListPanel } from "./components/VmListPanel";
import { VmPanel } from "./components/VmPanel";
import type { Sample } from "./types/model";

const WINDOW = 300; // last 5 minutes (one column per second)
const PROBES = ["runqlat", "memstall", "vms", "gpu", "biolat"] as const;
const EMPTY: Sample[] = [];
const PROCESS_KINDS = ["oom_kill", "crash", "crash_loop"] as const;
const TICK_MS = 30_000; // re-evaluate "ended within the last 5 minutes" even when no new data arrives
const RANK: Record<Level, number> = { ok: 0, caution: 1, warning: 2 };
const worst = (...xs: Level[]) => xs.reduce((a, b) => (RANK[a] >= RANK[b] ? a : b), "ok");

export default function App() {
  const path = usePath();
  const schemeKey = useColorSchemeKey();
  const { t } = useI18n();
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = useCallback(() => setNavOpen(false), []);

  const hosts = useQuery({
    queryKey: ["hosts"],
    queryFn: () => fetch("/api/hosts").then((r) => r.json() as Promise<HostInfo[]>),
    refetchInterval: 5000,
  });
  const [picked, setPicked] = useState<string>();
  const host = picked ?? hosts.data?.[0]?.name;
  // Keep receiving outside the screens, so the live view does not break when switching screens
  const { samples: byProbe, events, incidents, dropped, status } = useLiveHost(host, PROBES, WINDOW);
  const samples = byProbe.runqlat ?? EMPTY;
  const memSamples = byProbe.memstall ?? EMPTY;
  const vmSamples = byProbe.vms ?? EMPTY;
  const gpuSamples = byProbe.gpu ?? EMPTY;
  const diskSamples = byProbe.biolat ?? EMPTY;
  const life = useMemo(() => analyze(events), [events]);
  // The visible range follows the CPU samples; the memory screen uses the same 5 minutes
  const win = useMemo(() => timeWindow(samples, WINDOW), [samples]);
  // Levels come from the server's incidents (a periodic tick keeps the time-based ones fresh while nothing arrives)
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);
  const nowMs = Date.now();
  const cpuLevel = areaLevel(incidents, ["cpu_wait"], nowMs);
  const memLevel = areaLevel(incidents, ["mem_stall"], nowMs);
  const procLevel = areaLevel(incidents, PROCESS_KINDS, nowMs);
  const agentLevel = areaLevel(incidents, ["agent_down"], nowMs);
  // A VM stop, or a VM waiting for host CPU, counts toward the headline like any other area
  const vmLevel = areaLevel(incidents, VM_AREA_KINDS, nowMs);
  const gpuLevel = areaLevel(incidents, GPU_KINDS, nowMs);
  const diskLevel = areaLevel(incidents, DISK_KINDS, nowMs);
  const overall = worst(cpuLevel, memLevel, procLevel, agentLevel, vmLevel, gpuLevel, diskLevel);
  const levels = { "/": overall, "/all": overall, "/vms": vmLevel, "/cpu": cpuLevel, "/processes": procLevel, "/memory": memLevel, "/gpu": gpuLevel, "/disk": diskLevel };
  // The menu lists every known VM (running now, or with an incident in the last 24 h) with its own state and level
  const navVms: NavVm[] = knownVms(vmSamples, incidents, nowMs).map((v) => ({ name: v.name, running: v.running, level: v.level }));
  const match = matchRoute(path);
  const vmName = match?.params.name;
  const title = match ? t(match.labelKey, match.params) : "";

  return (
    <div>
      {/* Top bar (OpenSearch Dashboards style): ☰ / home / breadcrumb, with host, stream status and language on the right */}
      <header
        className="sticky top-0 z-40 flex h-12 items-center"
        style={{ background: "var(--surface-1)", borderBottom: "1px solid var(--border)" }}
      >
        <MenuButton open={navOpen} onToggle={() => setNavOpen((v) => !v)} />
        <Link
          to="/"
          onNavigate={closeNav}
          aria-label={t("app.homeAria")}
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
            aria-label={t("app.hostAria")}
          >
            {hosts.data?.length ? null : <option value="">{t("app.noHosts")}</option>}
            {hosts.data?.map((h) => (
              <option key={h.name} value={h.name}>{h.name}</option>
            ))}
          </select>
          {host && <StatusBadge status={status} />}
          <LangSwitch />
        </div>
      </header>
      <Nav path={path} open={navOpen} onClose={closeNav} levels={levels} vms={navVms} />

      <main className="mx-auto max-w-6xl px-4 py-6">
        {/* The screen name is shown in the top-bar breadcrumb, so this heading is for screen readers only */}
        <h1 className="sr-only">{title}</h1>
        {!host ? (
          <p style={{ color: "var(--text-secondary)" }}>
            {t("app.waitingPre")}<code>ebpflens-agent -server …</code>{t("app.waitingPost")}
          </p>
        ) : path === "/cpu" ? (
          <>
            <CpuLatencyCard samples={samples} win={win} schemeKey={schemeKey} />
            <div className="mt-6"><ImpactPanel samples={samples} incidents={incidents} /></div>
          </>
        ) : path === "/all" ? (
          <AllPanels>
            <PanelSection id="cpu" title={t("page.cpu")}>
              <CpuLatencyCard samples={samples} win={win} schemeKey={schemeKey} />
            </PanelSection>
            <PanelSection id="impact" title={t("page.impact")}>
              <ImpactPanel samples={samples} incidents={incidents} />
            </PanelSection>
            <PanelSection id="memory" title={t("page.memory")}>
              <MemoryPanel samples={memSamples} win={win} schemeKey={schemeKey} level={memLevel} />
            </PanelSection>
            <PanelSection id="processes" title={t("page.processes")}>
              <LifecyclePanel events={events} life={life} dropped={dropped} level={procLevel} />
            </PanelSection>
            <PanelSection id="disk" title={t("page.disk")}>
              <DiskPanel samples={diskSamples} win={win} schemeKey={schemeKey} level={diskLevel} />
            </PanelSection>
            <PanelSection id="gpu" title={t("page.gpu")}>
              <GpuPanel samples={gpuSamples} win={win} schemeKey={schemeKey} level={gpuLevel} />
            </PanelSection>
            <PanelSection id="vms" title={t("page.vms")}>
              <VmListPanel vmSamples={vmSamples} samples={samples} memSamples={memSamples} incidents={incidents} />
            </PanelSection>
          </AllPanels>
        ) : path === "/memory" ? (
          <MemoryPanel samples={memSamples} win={win} schemeKey={schemeKey} level={memLevel} />
        ) : path === "/disk" ? (
          <DiskPanel samples={diskSamples} win={win} schemeKey={schemeKey} level={diskLevel} />
        ) : path === "/gpu" ? (
          <GpuPanel samples={gpuSamples} win={win} schemeKey={schemeKey} level={gpuLevel} />
        ) : path === "/processes" ? (
          <LifecyclePanel events={events} life={life} dropped={dropped} level={procLevel} />
        ) : path === "/vms" ? (
          <VmListPanel vmSamples={vmSamples} samples={samples} memSamples={memSamples} incidents={incidents} />
        ) : vmName != null ? (
          <VmPanel
            name={vmName} vmSamples={vmSamples} samples={samples} memSamples={memSamples}
            incidents={incidents} win={win} schemeKey={schemeKey}
          />
        ) : (
          <>
            <LensSummary samples={samples} memSamples={memSamples} vmSamples={vmSamples} gpuSamples={gpuSamples} diskSamples={diskSamples} life={life} incidents={incidents} />
            <UseMatrix samples={samples} memSamples={memSamples} vmSamples={vmSamples} gpuSamples={gpuSamples} diskSamples={diskSamples} events={events} life={life} incidents={incidents} win={win} />
          </>
        )}
      </main>
    </div>
  );
}

// Lays out every panel from the per-area screens on a single page.
// When adding a probe, add a PanelSection here too (the dashboard stays an overview and does not grow vertically)
function AllPanels({ children }: { children: React.ReactNode }) {
  return (
    <>
      <JumpLinks />
      <div className="space-y-6">{children}</div>
    </>
  );
}

const SECTIONS: { id: string; titleKey: Key }[] = [
  { id: "cpu", titleKey: "page.cpu" },
  { id: "impact", titleKey: "page.impact" },
  { id: "memory", titleKey: "page.memory" },
  { id: "processes", titleKey: "page.processes" },
  { id: "disk", titleKey: "page.disk" },
  { id: "gpu", titleKey: "page.gpu" },
  { id: "vms", titleKey: "page.vms" },
];

function PanelSection({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    // scroll-margin so the section is not hidden under the top bar (48px tall)
    <section id={id} aria-label={title} className="scroll-mt-16">
      {children}
    </section>
  );
}

// The page is long, so put jump links to each panel at the top
function JumpLinks() {
  const { t } = useI18n();
  return (
    <nav aria-label={t("app.jumpAria")} className="mb-4 flex flex-wrap gap-2 text-xs">
      {SECTIONS.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          className="rounded-md px-2 py-1 hover:bg-[var(--surface-1)]"
          style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}
          onClick={(e) => {
            e.preventDefault();
            document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth" });
          }}
        >
          {t(s.titleKey)}
        </a>
      ))}
    </nav>
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
  const { t } = useI18n();
  const live = status === "live";
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
      <span aria-hidden style={{ color: live ? "var(--status-good)" : "var(--status-critical)" }}>
        {live ? "●" : "○"}
      </span>
      {/* On narrow screens show only the symbol (keep the text for screen readers) */}
      <span className="sr-only sm:not-sr-only">{t(live ? "status.live" : status === "connecting" ? "status.connecting" : "status.reconnecting")}</span>
    </span>
  );
}

// EN / Japanese toggle. The choice is saved by I18nProvider (localStorage, if available)
function LangSwitch() {
  const { lang, setLang, t } = useI18n();
  const options: { value: Lang; labelKey: Key }[] = [
    { value: "en", labelKey: "lang.en" },
    { value: "ja", labelKey: "lang.ja" },
  ];
  return (
    <div role="group" aria-label={t("lang.aria")} className="flex shrink-0 text-xs">
      {options.map((o, i) => {
        const active = lang === o.value;
        return (
          <button
            key={o.value}
            type="button"
            lang={o.value}
            aria-pressed={active}
            onClick={() => setLang(o.value)}
            className={`px-2 py-1 ${i === 0 ? "rounded-l-md" : "-ml-px rounded-r-md"}`}
            style={{
              border: "1px solid var(--border)",
              background: active ? "var(--page)" : "transparent",
              color: active ? "var(--text-primary)" : "var(--text-secondary)",
              fontWeight: active ? 600 : 400,
            }}
          >
            {t(o.labelKey)}
          </button>
        );
      })}
    </div>
  );
}
