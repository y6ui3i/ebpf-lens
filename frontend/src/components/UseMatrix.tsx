import type { Incident, ProcEvent, Sample } from "../types/model";
import { formatUs, percentile } from "../lib/hist";
import { current, LEVEL_COLOR, LEVEL_ICON, LEVEL_KEY, type Level } from "../lib/lens";
import { areaLevel } from "../lib/incidents";
import { useI18n, type Key } from "../lib/i18n";
import type { Lifecycle } from "../lib/lifecycle";
import type { TimeWindow } from "../lib/timeWindow";
import { Link } from "../lib/router";
import { Sparkline } from "./Sparkline";
import { currentMem, formatBytes, formatMsPerSec, memUsed, stallMsPerSec } from "../lib/memory";

// USE method (Brendan Gregg): look at utilization / saturation / errors for each resource.
// Adding probes only fills in cells; the screen does not grow vertically

type Cell =
  | { kind: "value"; value: string; note: string; level?: Level; spark?: (number | null)[]; log?: boolean; to?: string }
  | { kind: "planned"; roadmap: string }
  | { kind: "na" };

type Row = { resource: Key; cells: [Cell, Cell, Cell] };

const COLUMNS: { title: Key; hint: Key }[] = [
  { title: "use.col.util", hint: "use.col.utilHint" },
  { title: "use.col.sat", hint: "use.col.satHint" },
  { title: "use.col.err", hint: "use.col.errHint" },
];

// Levels in the cells come from the server's incidents; the numbers still come from samples and events
export function UseMatrix({ samples, memSamples, events, life, incidents, win }: {
  samples: Sample[]; memSamples: Sample[]; events: ProcEvent[]; life: Lifecycle; incidents: Incident[]; win: TimeWindow;
}) {
  const { lang, t } = useI18n();
  const nowMs = Date.now();
  const mem = currentMem(memSamples);
  const utilSeries = samples.map((s) => (s.cpus && s.intervalMs ? s.busyNs / (s.intervalMs * 1e6 * s.cpus) : null));
  const util = mean(utilSeries.slice(-5));
  const cpuNow = current(samples);
  const p99Series = samples.map((s) => percentile(s.slots, 0.99));
  const execSeries = perSecond(events.filter((e) => e.kind === "exec"), win);
  const cpuLevel = areaLevel(incidents, ["cpu_wait"], nowMs);
  const memLevel = areaLevel(incidents, ["mem_stall"], nowMs);
  const oomLevel = areaLevel(incidents, ["oom_kill"], nowMs);
  const crashLevel = areaLevel(incidents, ["crash", "crash_loop"], nowMs);

  const rows: Row[] = [
    {
      resource: "resource.cpu",
      cells: [
        { kind: "value", value: util == null ? "–" : `${Math.round(util * 100)}%`, note: t("use.cpuUtil"), spark: utilSeries, to: "/cpu" },
        {
          kind: "value", value: formatUs(cpuNow.p99), note: t("use.cpuSat"),
          level: cpuLevel, spark: p99Series, log: true, to: "/cpu",
        },
        { kind: "na" },
      ],
    },
    {
      resource: "resource.memory",
      cells: [
        {
          kind: "value", value: mem.used == null ? "–" : `${Math.round(mem.used * 100)}%`,
          note: mem.mem ? t("use.memUtil", { free: formatBytes(mem.mem.availableBytes) }) : "", spark: memSamples.map(memUsed), to: "/memory",
        },
        {
          kind: "value", value: formatMsPerSec(mem.stall, lang), note: t("use.memSat"),
          level: memLevel, spark: memSamples.map(stallMsPerSec), to: "/memory",
        },
        {
          kind: "value", value: `${life.ooms.length}`, note: t("use.memErr"),
          level: oomLevel, to: "/processes",
        },
      ],
    },
    {
      resource: "resource.processes",
      cells: [
        { kind: "value", value: `${life.execs.toLocaleString()}`, note: t("use.procUtil"), spark: execSeries, to: "/processes" },
        { kind: "na" },
        { kind: "value", value: `${life.crashes.length}`, note: t("use.procErr"), level: crashLevel, to: "/processes" },
      ],
    },
    { resource: "resource.disk", cells: [{ kind: "planned", roadmap: "11" }, { kind: "planned", roadmap: "11" }, { kind: "planned", roadmap: "11" }] },
    { resource: "resource.network", cells: [{ kind: "planned", roadmap: "11" }, { kind: "planned", roadmap: "11" }, { kind: "planned", roadmap: "11" }] },
    { resource: "resource.gpu", cells: [{ kind: "planned", roadmap: "9" }, { kind: "planned", roadmap: "10" }, { kind: "planned", roadmap: "9" }] },
  ];

  return (
    <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
      <div className="mb-3">
        <h2 className="text-lg font-semibold">{t("use.title")}</h2>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>{t("use.desc")}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] table-fixed text-sm tabular">
          <thead>
            <tr style={{ color: "var(--text-muted)" }}>
              <th className="w-24 py-1 text-left font-normal" />
              {COLUMNS.map((c) => (
                <th key={c.title} className="px-2 py-1 text-left font-normal">
                  <span style={{ color: "var(--text-secondary)" }}>{t(c.title)}</span>
                  <span className="ml-1 text-xs">{t(c.hint)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.resource} style={{ borderTop: "1px solid var(--grid)" }}>
                <th className="py-2 text-left align-top font-semibold">{t(r.resource)}</th>
                {r.cells.map((c, i) => (
                  <td key={i} className="px-2 py-2 align-top">
                    <CellView cell={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CellView({ cell }: { cell: Cell }) {
  const { t } = useI18n();
  if (cell.kind === "na") return <span style={{ color: "var(--text-muted)" }}>—</span>;
  if (cell.kind === "planned") {
    return <span className="text-xs" style={{ color: "var(--text-muted)" }}>{t("use.planned", { n: cell.roadmap })}</span>;
  }
  // Stay quiet when OK; add an icon and color only for caution / warning
  const alert = cell.level && cell.level !== "ok";
  const body = (
    <>
      <div className="flex items-baseline gap-1.5">
        {alert && (
          <span aria-hidden style={{ color: LEVEL_COLOR[cell.level!] }}>{LEVEL_ICON[cell.level!]}</span>
        )}
        <span className={alert ? "text-lg font-semibold" : "text-lg"}>{cell.value}</span>
        {alert && <span className="text-xs" style={{ color: "var(--text-secondary)" }}>{t(LEVEL_KEY[cell.level!])}</span>}
      </div>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>{cell.note}</div>
      {cell.spark && <div className="mt-1"><Sparkline values={cell.spark} log={cell.log} label={t("use.sparkAria", { note: cell.note })} /></div>}
    </>
  );
  if (!cell.to) return body;
  return (
    <Link to={cell.to} className="-m-1 block rounded-md p-1 hover:bg-[var(--page)]">
      {body}
    </Link>
  );
}

function mean(xs: (number | null)[]): number | null {
  const k = xs.filter((v): v is number => v != null);
  return k.length ? k.reduce((a, b) => a + b, 0) / k.length : null;
}

// Turn events into per-second counts (aligned to the visible range)
function perSecond(events: ProcEvent[], win: TimeWindow): number[] {
  const n = Math.round((win.endMs - win.startMs) / 1000) + 1;
  const out = new Array<number>(n).fill(0);
  for (const e of events) {
    const i = Math.round((Date.parse(e.time) - win.startMs) / 1000);
    if (i >= 0 && i < n) out[i]++;
  }
  return out;
}
