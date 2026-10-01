import { useMemo, useRef, useState } from "react";
import type { Incident, Sample } from "../types/model";
import { asLevel } from "../lib/incidents";
import { LEVEL_COLOR, type Level } from "../lib/lens";
import { percentile, formatUs } from "../lib/hist";
import { stallMsPerSec, formatMsPerSec } from "../lib/memory";
import { gpuUtil } from "../lib/gpu";
import { retransPerSec } from "../lib/net";
import { lockSecPerSec } from "../lib/locks";
import { useHistoryRange } from "../lib/history";
import { navigate } from "../lib/router";
import { formatHM, formatTime, useI18n, type Key, type Lang } from "../lib/i18n";
import { IncidentTable } from "./IncidentTable";

const RANGES: { key: Key; ms: number }[] = [
  { key: "history.range1h", ms: 60 * 60 * 1000 },
  { key: "history.range6h", ms: 6 * 60 * 60 * 1000 },
  { key: "history.range24h", ms: 24 * 60 * 60 * 1000 },
];
const POINTS = 360; // buckets per range: 10 s for an hour, 1 min for 6 h, 4 min for a day
const ROW_H = 34;
const LABEL_W = 104;
const RANK: Record<Level, number> = { ok: 0, caution: 1, warning: 2 };

type Row = {
  key: Key; path: string; probe: string; kinds: string[];
  value?: (s: Sample) => number | null; log?: boolean; format?: (v: number, lang: Lang) => string;
};

// One row per area: the incidents of its kinds as bands in their level's color, and the area's representative value
// as a line. Clicking a moment opens that area's screen at that moment (?at=), with its full one-second detail
const ROWS: Row[] = [
  { key: "resource.cpu", path: "/cpu", probe: "runqlat", kinds: ["cpu_wait"], value: (s) => percentile(s.slots, 0.99), log: true, format: (v) => formatUs(v) },
  { key: "resource.memory", path: "/memory", probe: "memstall", kinds: ["mem_stall", "oom_kill"], value: stallMsPerSec, format: (v, l) => formatMsPerSec(v, l) },
  { key: "resource.processes", path: "/processes", probe: "", kinds: ["crash", "crash_loop"] },
  { key: "resource.vms", path: "/vms", probe: "vms", kinds: ["vm_down", "vm_cpu_wait"], value: (s) => s.vms?.length ?? 0, format: (v) => `${v}` },
  { key: "resource.disk", path: "/disk", probe: "biolat", kinds: ["disk_slow", "disk_error"], value: (s) => percentile(s.slots, 0.99), log: true, format: (v) => formatUs(v) },
  { key: "resource.network", path: "/network", probe: "tcpconn", kinds: ["net_connect_fail", "net_connect_slow", "net_retrans", "net_drop"], value: retransPerSec, format: (v) => `${v.toFixed(1)}/s` },
  { key: "resource.dns", path: "/dns", probe: "dnslat", kinds: ["dns_fail", "dns_slow"], value: (s) => percentile(s.slots, 0.99), log: true, format: (v) => formatUs(v) },
  { key: "resource.files", path: "/files", probe: "fileops", kinds: ["file_fail", "fsync_slow"], value: (s) => percentile(s.slots, 0.99), log: true, format: (v) => formatUs(v) },
  { key: "resource.locks", path: "/locks", probe: "lockwait", kinds: ["lock_wait"], value: lockSecPerSec, format: (v) => v.toFixed(2) },
  { key: "resource.gpu", path: "/gpu", probe: "gpu", kinds: ["gpu_starved", "vram_full"], value: (s) => { const u = gpuUtil(s); return u == null ? null : u * 100; }, format: (v) => `${Math.round(v)}%` },
];
const PROBES = ["runqlat", "memstall", "vms", "biolat", "tcpconn", "dnslat", "fileops", "lockwait", "gpu"] as const;

// The last 1 / 6 / 24 hours at a glance: when and where something happened, then a click into that area at that time
export function HistoryPanel({ host, incidents }: { host: string; incidents: Incident[] }) {
  const { lang, t } = useI18n();
  // Starts at 1 hour: a day of one-second samples takes seconds to read and fold (the 30-day rollups will fix that)
  const [range, setRange] = useState(RANGES[0].ms);
  const [now] = useState(() => Date.now());
  const toMs = now;
  const fromMs = toMs - range;
  const bucketSec = Math.max(1, Math.round(range / POINTS / 1000));
  const q = useHistoryRange(host, PROBES, fromMs, toMs, bucketSec);
  const inRange = useMemo(
    () => incidents.filter((x) => Date.parse(x.start) <= toMs && (x.end ? Date.parse(x.end) : toMs) >= fromMs),
    [incidents, fromMs, toMs],
  );
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null); // ms under the cursor

  const xOf = (ms: number) => ((ms - fromMs) / (toMs - fromMs)) * 100; // percent of the plot width
  const msAt = (clientX: number) => {
    const el = wrap.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const f = (clientX - r.left - LABEL_W) / (r.width - LABEL_W);
    return f < 0 || f > 1 ? null : fromMs + f * (toMs - fromMs);
  };
  const ticks = useMemo(() => {
    const step = range <= 3_600_000 ? 10 * 60_000 : range <= 21_600_000 ? 60 * 60_000 : 3 * 60 * 60_000;
    const out: number[] = [];
    for (let m = Math.ceil(fromMs / step) * step; m <= toMs; m += step) out.push(m);
    return out;
  }, [fromMs, toMs, range]);

  return (
    <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("history.title")}</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{t("history.desc")}</p>
        </div>
        <div role="group" aria-label={t("history.rangeAria")} className="flex text-xs">
          {RANGES.map((r, i) => (
            <button
              key={r.ms}
              onClick={() => setRange(r.ms)}
              aria-pressed={range === r.ms}
              className={`px-2.5 py-1 ${i === 0 ? "rounded-l-md" : i === RANGES.length - 1 ? "-ml-px rounded-r-md" : "-ml-px"}`}
              style={{
                border: "1px solid var(--border)", background: range === r.ms ? "var(--page)" : "transparent",
                color: range === r.ms ? "var(--text-primary)" : "var(--text-secondary)", fontWeight: range === r.ms ? 600 : 400,
              }}
            >
              {t(r.key)}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
        {t("history.note", { from: formatTime(lang, new Date(fromMs).toISOString()), to: formatTime(lang, new Date(toMs).toISOString()), step: bucketSec })}
      </p>

      <div
        ref={wrap}
        className="relative mt-4 cursor-crosshair select-none"
        onMouseMove={(e) => setHover(msAt(e.clientX))}
        onMouseLeave={() => setHover(null)}
      >
        {ROWS.map((row) => {
          const xs = row.probe ? q.data?.[row.probe] ?? [] : [];
          const bands = inRange.filter((x) => row.kinds.includes(x.kind));
          return (
            <div
              key={row.key}
              className="flex items-center"
              style={{ height: ROW_H, borderTop: "1px solid var(--grid)" }}
              onClick={(e) => {
                const ms = msAt(e.clientX);
                if (ms != null) navigate(`${row.path}?at=${Math.round(ms)}`);
              }}
            >
              <div className="shrink-0 text-sm font-semibold" style={{ width: LABEL_W }}>{t(row.key)}</div>
              <div className="relative h-full min-w-0 flex-1">
                {bands.map((x) => {
                  const a = Math.max(fromMs, Date.parse(x.start));
                  const b = Math.min(toMs, x.end ? Date.parse(x.end) : toMs);
                  const level = asLevel(x.level);
                  return (
                    <div
                      key={x.id}
                      title={`${formatTime(lang, x.start)} ${t(`incident.kind.${x.kind}` as Key)}`}
                      className="absolute top-1 bottom-1 rounded-sm"
                      style={{ left: `${xOf(a)}%`, width: `max(3px, ${xOf(b) - xOf(a)}%)`, background: LEVEL_COLOR[level], opacity: RANK[level] > 1 ? 0.55 : 0.4 }}
                    />
                  );
                })}
                {row.value && <Line xs={xs} value={row.value} log={row.log} xOf={xOf} />}
              </div>
            </div>
          );
        })}
        {/* time axis */}
        <div className="relative flex" style={{ height: 22, borderTop: "1px solid var(--grid)" }}>
          <div style={{ width: LABEL_W }} />
          <div className="relative flex-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
            {ticks.map((m) => (
              <span key={m} className="absolute top-1 -translate-x-1/2" style={{ left: `${xOf(m)}%` }}>{formatHM(lang, new Date(m).toISOString())}</span>
            ))}
          </div>
        </div>
        {hover != null && (
          <div className="pointer-events-none absolute top-0 bottom-[22px]" style={{ left: `calc(${LABEL_W}px + (100% - ${LABEL_W}px) * ${(hover - fromMs) / (toMs - fromMs)})`, borderLeft: "1px dashed var(--text-muted)" }}>
            <span className="absolute -top-5 -translate-x-1/2 rounded px-1 text-[11px]" style={{ background: "var(--page)", color: "var(--text-secondary)" }}>
              {formatTime(lang, new Date(hover).toISOString())}
            </span>
          </div>
        )}
      </div>
      <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
        {q.isLoading ? t("history.loading") : q.isError ? t("history.error") : t("history.clickHint")}
      </p>

      <h3 className="mt-6 mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("history.incidents", { n: inRange.length })}</h3>
      {inRange.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>{t("common.none")}</p>
      ) : (
        <IncidentTable incidents={inRange.slice(0, 50)} nowMs={now} />
      )}
    </section>
  );
}

// The area's representative value over the range, scaled to its own maximum (log for latencies)
function Line({ xs, value, log, xOf }: { xs: Sample[]; value: (s: Sample) => number | null; log?: boolean; xOf: (ms: number) => number }) {
  const pts = xs.map((s) => [xOf(Date.parse(s.time)), value(s)] as const).filter((p): p is readonly [number, number] => p[1] != null);
  if (pts.length < 2) return null;
  const f = (v: number) => (log ? Math.log10(Math.max(v, 1)) : v);
  const top = Math.max(...pts.map((p) => f(p[1])), log ? 3 : 1e-9);
  const y = (v: number) => 92 - (f(v) / top) * 84; // percent of the row height, leaving a margin
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(2)},${y(p[1]).toFixed(2)}`).join("");
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
      <path d={d} fill="none" stroke="var(--series-1)" strokeWidth={1.4} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
