import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import type { Sample } from "../types/model";
import type { TimeWindow } from "../lib/timeWindow";
import { cssVar } from "../lib/theme";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_KEY } from "../lib/lens";
import { formatHMS, formatTime, useI18n } from "../lib/i18n";
import {
  CAUTION_MS_PER_S, WARNING_MS_PER_S, currentMem, formatBytes, formatMsPerSec, psiMsPerSec, stallMsPerSec, stalledProcs,
} from "../lib/memory";
import { Heatmap, CHART_HEIGHT } from "./Heatmap";

// Time processes spent stalled freeing memory themselves (reclaim) because memory ran short
export function MemoryPanel({ samples, win, schemeKey }: { samples: Sample[]; win: TimeWindow; schemeKey: string }) {
  const { lang, t } = useI18n();
  const now = currentMem(samples);
  const procs = stalledProcs(samples);
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  return (
    <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
      <h2 className="text-lg font-semibold">{t("mem.title")}</h2>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>Memory reclaim stall · direct / memcg reclaim</div>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        {t("mem.desc")}
      </p>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Tile label={t("mem.tileStall")} value={formatMsPerSec(now.stall, lang)} note={t("mem.tileStallNote")} level={now.level} />
        <Tile label={t("mem.tileUsed")} value={now.used == null ? "–" : `${Math.round(now.used * 100)}%`} note={now.mem ? t("mem.tileUsedNote", { total: formatBytes(now.mem.totalBytes) }) : ""} />
        <Tile label={t("mem.tileAvail")} value={now.mem ? formatBytes(now.mem.availableBytes) : "–"} note={t("mem.tileAvailNote")} />
        <Tile label="PSI some" value={formatMsPerSec(samples.at(-1) ? psiMsPerSec(samples.at(-1)!) : null, lang)} note={t("mem.tilePsiNote")} />
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("mem.distTitle")}</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("mem.distNote")}</p>
          <Heatmap samples={samples} win={win} schemeKey={schemeKey} hoverMs={hoverMs} onHover={setHoverMs}
            ariaLabel={t("mem.heatAria")}
            yCaption={t("mem.heatYCaption")} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("mem.trendTitle")}</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>
            {t("mem.trendNote", { c: CAUTION_MS_PER_S, w: WARNING_MS_PER_S })}
          </p>
          <StallChart samples={samples} win={win} schemeKey={schemeKey} />
        </div>
      </div>

      <div className="mt-6">
        <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("mem.procsTitle")}</h3>
        {procs.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>{t("common.none")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm tabular">
              <thead style={{ color: "var(--text-muted)" }}>
                <tr>
                  <th className="py-1 text-left font-normal">{t("common.process")}</th>
                  <th className="py-1 text-right font-normal">{t("mem.colTotal")}</th>
                  <th className="py-1 text-right font-normal">{t("common.count")}</th>
                  <th className="py-1 text-right font-normal">{t("mem.colMax")}</th>
                  <th className="py-1 text-right font-normal">{t("mem.colReclaimed")}</th>
                  <th className="py-1 text-right font-normal">{t("mem.colCause")}</th>
                </tr>
              </thead>
              <tbody>
                {procs.slice(0, 8).map((p) => (
                  <tr key={p.comm} style={{ borderTop: "1px solid var(--grid)" }}>
                    <td className="py-1.5">{p.procs > 1 ? `${p.comm} ×${p.procs}` : p.comm}</td>
                    <td className="py-1.5 text-right">{(p.totalNs / 1e6).toFixed(1)} ms</td>
                    <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{p.count.toLocaleString()}</td>
                    <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{(p.maxNs / 1e6).toFixed(2)} ms</td>
                    <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatBytes(p.reclaimedPages * 4096)}</td>
                    <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>
                      {t(p.memcgCount === p.count ? "mem.causeMemcg" : p.memcgCount === 0 ? "mem.causeHost" : "mem.causeBoth")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function Tile({ label, value, note, level }: { label: string; value: string; note: string; level?: "ok" | "caution" | "warning" }) {
  const { t } = useI18n();
  const alert = level && level !== "ok";
  return (
    <div>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</div>
      <div className="flex items-center gap-1.5 text-2xl font-semibold">
        {alert && <span aria-hidden className="text-base" style={{ color: LEVEL_COLOR[level] }}>{LEVEL_ICON[level]}</span>}
        {value}
        {alert && <span className="sr-only">{t(LEVEL_KEY[level])}</span>}
      </div>
      <div className="text-xs" style={{ color: "var(--text-secondary)" }}>{note}</div>
    </div>
  );
}

// Plots eBPF stall time and PSI some in the same unit (ms/s) on the same axis
function StallChart({ samples, win, schemeKey }: { samples: Sample[]; win: TimeWindow; schemeKey: string }) {
  const { lang, t } = useI18n();
  const wrapRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const winRef = useRef(win);
  winRef.current = win;

  const data = useMemo<uPlot.AlignedData>(
    () => [samples.map((s) => Date.parse(s.time) / 1000), samples.map(stallMsPerSec), samples.map(psiMsPerSec)],
    [samples],
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const axis = {
      stroke: cssVar("--text-muted"),
      grid: { stroke: cssVar("--grid"), width: 1 },
      ticks: { stroke: cssVar("--axis"), width: 1 },
      font: "11px system-ui, sans-serif",
    };
    const u = new uPlot(
      {
        width: el.clientWidth,
        height: CHART_HEIGHT,
        padding: [8, 12, 0, 0],
        scales: {
          x: { time: true, range: () => [winRef.current.startMs / 1000, winRef.current.endMs / 1000] },
          // Keep the top at least slightly above the warning threshold so the thresholds are visible even at the normal value (0)
          y: { range: (_u, _min, max) => [0, Math.max(max ?? 0, WARNING_MS_PER_S) * 1.1] },
        },
        axes: [
          {
            ...axis, space: 80,
            values: (_u, vals) => vals.map((v) => formatHMS(lang, v * 1000)),
          },
          { ...axis, size: 60, values: (_u, vals) => vals.map((v) => `${v} ms`) },
        ],
        series: [
          { label: t("common.time"), value: (_u, v) => (v == null ? "–" : formatTime(lang, v * 1000)) },
          { label: t("mem.seriesEbpf"), stroke: cssVar("--series-1"), width: 2, points: { show: false }, value: (_u, v) => formatMsPerSec(v, lang) },
          { label: t("mem.seriesPsi"), stroke: cssVar("--series-2"), width: 2, points: { show: false }, value: (_u, v) => formatMsPerSec(v, lang) },
        ],
        hooks: {
          drawAxes: [
            (u) => {
              const ctx = u.ctx;
              const { left, width } = u.bbox;
              ctx.save();
              for (const [v, color, label] of [
                [CAUTION_MS_PER_S, cssVar("--status-warning"), t("chart.caution", { v: `${CAUTION_MS_PER_S} ${t("unit.msPerSec")}` })],
                [WARNING_MS_PER_S, cssVar("--status-critical"), t("chart.warning", { v: `${WARNING_MS_PER_S} ${t("unit.msPerSec")}` })],
              ] as const) {
                const y = u.valToPos(v, "y", true);
                ctx.strokeStyle = color;
                ctx.globalAlpha = 0.8;
                ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
                ctx.beginPath();
                ctx.moveTo(left, y);
                ctx.lineTo(left + width, y);
                ctx.stroke();
                ctx.globalAlpha = 1;
                ctx.fillStyle = cssVar("--text-muted");
                ctx.font = `${10 * devicePixelRatio}px system-ui, sans-serif`;
                // uPlot calls this hook with the right alignment it used for the y-axis ticks, so switch back to left
                ctx.textAlign = "left";
                ctx.textBaseline = "bottom";
                ctx.fillText(label, left + 4 * devicePixelRatio, y - 2 * devicePixelRatio);
              }
              ctx.restore();
            },
          ],
        },
      },
      data,
      el,
    );
    plotRef.current = u;
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height: CHART_HEIGHT }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
    };
  }, [schemeKey, lang]); // colors and labels are read at creation, so rebuild on theme or language change

  useEffect(() => {
    plotRef.current?.setData(data);
  }, [data]);

  return <div ref={wrapRef} className="w-full" role="img" aria-label={t("mem.chartAria")} />;
}
