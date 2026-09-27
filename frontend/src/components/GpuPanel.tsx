import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import type { Sample } from "../types/model";
import type { TimeWindow } from "../lib/timeWindow";
import { cssVar } from "../lib/theme";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_KEY, type Level } from "../lib/lens";
import { useTriggers } from "../lib/useTriggers";
import { formatHMS, formatTime, useI18n } from "../lib/i18n";
import { formatBytes } from "../lib/memory";
import { VERDICT_KEY, currentGpu, formatRate, gpuProcs, gpuUtil, pct, throttleKey, vramUsed } from "../lib/gpu";
import { Heatmap, CHART_HEIGHT } from "./Heatmap";

// The GPU: how busy it is (NVML) and, per CUDA process, where the time goes (uprobes on libcuda).
// `level` is the GPU area's level from the server's gpu_starved / vram_full incidents
export function GpuPanel({ samples, win, schemeKey, level }: { samples: Sample[]; win: TimeWindow; schemeKey: string; level: Level }) {
  const { t } = useI18n();
  const triggers = useTriggers().gpu;
  const now = currentGpu(samples);
  const rows = gpuProcs(samples, triggers.idleUtil);
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const withUprobes = samples.at(-1)?.gpu?.uprobes ?? false;

  if (!now.gpu) {
    return (
      <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
        <h2 className="text-lg font-semibold">{t("gpu.title")}</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>{t("gpu.none")}</p>
      </section>
    );
  }
  const g = now.gpu;

  return (
    <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
      <h2 className="text-lg font-semibold">{t("gpu.title")}</h2>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>{g.name} · NVML + uprobes on libcuda</div>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{t("gpu.desc")}</p>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Tile label={t("gpu.tileUtil")} value={pct(now.util)} note={t("gpu.tileUtilNote")} level={level} />
        <Tile label={t("gpu.tileVram")} value={pct(now.vram)} note={t("gpu.tileVramNote", { used: formatBytes(g.usedBytes), total: formatBytes(g.totalBytes) })} />
        <Tile label={t("gpu.tileTemp")} value={`${g.tempC} °C`} note={g.throttle?.length ? t("gpu.tileThrottle", { why: g.throttle.map((x) => t(throttleKey(x))).join(t("list.sep")) }) : t("gpu.tileTempNote")} />
        <Tile label={t("gpu.tilePower")} value={`${Math.round(g.powerW)} W`} note={t("gpu.tilePowerNote")} />
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("gpu.trendTitle")}</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("gpu.trendNote", { idle: Math.round(triggers.idleUtil * 100), vram: Math.round(triggers.vram.caution * 100) })}</p>
          <UtilChart samples={samples} win={win} schemeKey={schemeKey} idleUtil={triggers.idleUtil} vramCaution={triggers.vram.caution} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("gpu.distTitle")}</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("gpu.distNote")}</p>
          <Heatmap samples={samples} win={win} schemeKey={schemeKey} hoverMs={hoverMs} onHover={setHoverMs}
            ariaLabel={t("gpu.heatAria")} yCaption={t("gpu.heatYCaption")} />
        </div>
      </div>

      <div className="mt-6">
        <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("gpu.procsTitle")}</h3>
        {!withUprobes && <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("gpu.noUprobes")}</p>}
        {rows.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>{t("gpu.noProcs")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm tabular">
              <thead style={{ color: "var(--text-muted)" }}>
                <tr>
                  <th className="py-1 text-left font-normal">{t("common.process")}</th>
                  <th className="py-1 text-left font-normal">{t("gpu.colVerdict")}</th>
                  <th className="py-1 text-right font-normal">{t("gpu.colVram")}</th>
                  <th className="py-1 text-right font-normal">{t("gpu.colLaunches")}</th>
                  <th className="py-1 text-right font-normal">{t("gpu.colH2d")}</th>
                  <th className="py-1 text-right font-normal">{t("gpu.colD2h")}</th>
                  <th className="py-1 text-right font-normal">{t("gpu.colSync")}</th>
                  <th className="py-1 text-right font-normal">{t("gpu.colCopy")}</th>
                  <th className="py-1 text-right font-normal">{t("gpu.colCpu")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 8).map((p) => (
                  <tr key={p.comm} style={{ borderTop: "1px solid var(--grid)" }}>
                    <td className="py-1.5">{p.procs > 1 ? `${p.comm} ×${p.procs}` : p.comm}</td>
                    <td className="py-1.5" style={{ color: "var(--text-secondary)" }}>{t(VERDICT_KEY[p.verdict])}</td>
                    <td className="py-1.5 text-right">{formatBytes(p.vramBytes)}</td>
                    <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{Math.round(p.launchesPerSec).toLocaleString()}/s</td>
                    <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatRate(p.h2dBytesPerSec)}</td>
                    <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatRate(p.d2hBytesPerSec)}</td>
                    <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{pct(p.syncShare)}</td>
                    <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{pct(p.copyShare)}</td>
                    <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{pct(p.cpuShare)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("gpu.procsNote")}</p>
      </div>
    </section>
  );
}

function Tile({ label, value, note, level }: { label: string; value: string; note: string; level?: Level }) {
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

// GPU utilization and VRAM in use on one 0-100 % axis, with the idle line (below it a busy process starves the GPU)
// and the VRAM caution line from the server's rules
function UtilChart({ samples, win, schemeKey, idleUtil, vramCaution }: {
  samples: Sample[]; win: TimeWindow; schemeKey: string; idleUtil: number; vramCaution: number;
}) {
  const { lang, t } = useI18n();
  const wrapRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const winRef = useRef(win);
  winRef.current = win;

  const data = useMemo<uPlot.AlignedData>(
    () => [
      samples.map((s) => Date.parse(s.time) / 1000),
      samples.map((s) => { const v = gpuUtil(s); return v == null ? null : v * 100; }),
      samples.map((s) => { const v = vramUsed(s); return v == null ? null : v * 100; }),
    ],
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
          y: { range: () => [0, 100] },
        },
        axes: [
          { ...axis, space: 80, values: (_u, vals) => vals.map((v) => formatHMS(lang, v * 1000)) },
          { ...axis, size: 50, values: (_u, vals) => vals.map((v) => `${v}%`) },
        ],
        series: [
          { label: t("common.time"), value: (_u, v) => (v == null ? "–" : formatTime(lang, v * 1000)) },
          { label: t("gpu.seriesUtil"), stroke: cssVar("--series-1"), width: 2, points: { show: false }, value: (_u, v) => (v == null ? "–" : `${Math.round(v)}%`) },
          { label: t("gpu.seriesVram"), stroke: cssVar("--series-2"), width: 2, points: { show: false }, value: (_u, v) => (v == null ? "–" : `${Math.round(v)}%`) },
        ],
        hooks: {
          drawAxes: [
            (u) => {
              const ctx = u.ctx;
              const { left, width } = u.bbox;
              ctx.save();
              for (const [v, color, label] of [
                [idleUtil * 100, cssVar("--status-warning"), t("gpu.lineIdle", { v: Math.round(idleUtil * 100) })],
                [vramCaution * 100, cssVar("--status-critical"), t("gpu.lineVram", { v: Math.round(vramCaution * 100) })],
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
                ctx.textAlign = "left"; // uPlot leaves the y-axis tick alignment in the context
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
  }, [schemeKey, lang, idleUtil, vramCaution]); // colors, labels and thresholds are read at creation

  useEffect(() => {
    plotRef.current?.setData(data);
  }, [data]);

  return <div ref={wrapRef} className="w-full" role="img" aria-label={t("gpu.chartAria")} />;
}
