import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import type { Sample } from "../types/model";
import type { TimeWindow } from "../lib/timeWindow";
import { cssVar } from "../lib/theme";
import { formatHMS, formatTime, useI18n } from "../lib/i18n";
import { formatUs, percentile } from "../lib/hist";
import { CHART_HEIGHT } from "./Heatmap";

// p50 / p99 of a per-second log2 latency histogram on a log axis, with the server's thresholds (µs) as lines.
// Shared by the disk and network screens (the CPU screen has its own richer PercentileChart)
export function LatencyChart({ samples, win, schemeKey, caution, warning, ariaLabel }: {
  samples: Sample[]; win: TimeWindow; schemeKey: string; caution: number; warning: number; ariaLabel: string;
}) {
  const { lang, t } = useI18n();
  const wrapRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const winRef = useRef(win);
  winRef.current = win;

  const data = useMemo<uPlot.AlignedData>(
    () => [
      samples.map((s) => Date.parse(s.time) / 1000),
      samples.map((s) => percentile(s.slots, 0.99)),
      samples.map((s) => percentile(s.slots, 0.5)),
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
          y: { distr: 3, log: 10, range: () => [1, Math.max(warning * 10, 1_000_000)] },
        },
        axes: [
          { ...axis, space: 80, values: (_u, vals) => vals.map((v) => formatHMS(lang, v * 1000)) },
          { ...axis, size: 60, values: (_u, vals) => vals.map((v) => formatUs(v)) },
        ],
        series: [
          { label: t("common.time"), value: (_u, v) => (v == null ? "–" : formatTime(lang, v * 1000)) },
          { label: "p99", stroke: cssVar("--series-1"), width: 2, points: { show: false }, value: (_u, v) => formatUs(v) },
          { label: "p50", stroke: cssVar("--series-2"), width: 2, points: { show: false }, value: (_u, v) => formatUs(v) },
        ],
        hooks: {
          drawAxes: [
            (u) => {
              const ctx = u.ctx;
              const { left, width } = u.bbox;
              ctx.save();
              for (const [v, color, label] of [
                [caution, cssVar("--status-warning"), t("chart.caution", { v: formatUs(caution) })],
                [warning, cssVar("--status-critical"), t("chart.warning", { v: formatUs(warning) })],
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
  }, [schemeKey, lang, caution, warning]);

  useEffect(() => {
    plotRef.current?.setData(data);
  }, [data]);

  return <div ref={wrapRef} className="w-full" role="img" aria-label={ariaLabel} />;
}
