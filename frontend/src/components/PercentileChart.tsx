import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { Sample } from "../types/model";
import { formatUs, percentile } from "../lib/hist";
import { cssVar } from "../lib/theme";
import { useTriggers } from "../lib/useTriggers";
import type { TimeWindow } from "../lib/timeWindow";
import { CHART_HEIGHT } from "./Heatmap";
import { formatHMS, formatTime, useI18n, type Key } from "../lib/i18n";

const SERIES: { label: string; legend: Key; q: number; color: string }[] = [
  { label: "p50", legend: "cpu.seriesP50", q: 0.5, color: "--series-1" },
  { label: "p99", legend: "cpu.seriesP99", q: 0.99, color: "--series-2" },
];

type Props = {
  samples: Sample[];
  win: TimeWindow;
  schemeKey: string;
  hoverMs: number | null; // cursor time shared with the heatmap
  onHover: (ms: number | null) => void;
};

export function PercentileChart({ samples, win, schemeKey, hoverMs, onHover }: Props) {
  const { lang, t } = useI18n();
  // Threshold bands follow the server's trigger thresholds (µs)
  const { caution: cautionUs, warning: warningUs } = useTriggers().cpu;
  const wrapRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const lineRef = useRef<HTMLDivElement | null>(null);
  // uPlot callbacks are fixed at creation, so read the latest values through refs
  const winRef = useRef(win);
  winRef.current = win;
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;

  const data = useMemo<uPlot.AlignedData>(() => {
    const xs = samples.map((s) => Date.parse(s.time) / 1000);
    const ys = SERIES.map(({ q }) => samples.map((s) => percentile(s.slots, q)));
    return [xs, ...ys];
  }, [samples]);

  // Rebuild when the theme, language or thresholds change (colors, labels and bands are read at creation)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let pointerInside = false;
    const axis = {
      stroke: cssVar("--text-muted"),
      grid: { stroke: cssVar("--grid"), width: 1 },
      ticks: { stroke: cssVar("--axis"), width: 1 },
      font: "11px system-ui, sans-serif",
    };
    const opts: uPlot.Options = {
      width: el.clientWidth,
      height: CHART_HEIGHT,
      padding: [8, 40, 0, 0], // room on the right to label the series directly
      scales: {
        // pin the x axis to the same range as the heatmap
        x: { time: true, range: () => [winRef.current.startMs / 1000, winRef.current.endMs / 1000] },
        // pin the y axis to 1µs-100ms so the threshold bands are visible even in normal times
        y: { distr: 3, log: 10, range: () => [1, 100_000] },
      },
      axes: [
        {
          ...axis,
          space: 80,
          values: (_u, vals) =>
            vals.map((v) => formatHMS(lang, v * 1000)),
        },
        { ...axis, size: 56, values: (_u, vals) => vals.map((v) => formatUs(v)) },
      ],
      series: [
        { label: t("common.time"), value: (_u, v) => (v == null ? "–" : formatTime(lang, v * 1000)) },
        ...SERIES.map((s) => ({
          label: t(s.legend),
          stroke: cssVar(s.color),
          width: 2,
          points: { show: false },
          value: (_u: uPlot, v: number | null) => formatUs(v),
        })),
      ],
      cursor: { points: { size: 8 } },
      hooks: {
        setCursor: [
          (u) => {
            // Also called on data updates, so only sync while the pointer is over this chart
            if (!pointerInside) return;
            const left = u.cursor.left;
            onHoverRef.current(left == null || left < 0 ? null : u.posToVal(left, "x") * 1000);
          },
        ],
        // Threshold bands, drawn after the axes and before the lines
        drawAxes: [
          (u) => {
            const ctx = u.ctx;
            const { left, width, top } = u.bbox;
            const yOf = (v: number) => u.valToPos(v, "y", true);
            const bands = [
              { from: cautionUs, to: warningUs, color: cssVar("--status-warning"), label: t("chart.caution", { v: formatUs(cautionUs) }) },
              { from: warningUs, to: 100_000, color: cssVar("--status-critical"), label: t("chart.warning", { v: formatUs(warningUs) }) },
            ];
            ctx.save();
            for (const b of bands) {
              const y1 = Math.max(top, yOf(b.to));
              const y0 = yOf(b.from);
              ctx.globalAlpha = 0.1;
              ctx.fillStyle = b.color;
              ctx.fillRect(left, y1, width, y0 - y1);
              ctx.globalAlpha = 0.8;
              ctx.strokeStyle = b.color;
              ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
              ctx.beginPath();
              ctx.moveTo(left, y0);
              ctx.lineTo(left + width, y0);
              ctx.stroke();
              ctx.globalAlpha = 1;
              ctx.fillStyle = cssVar("--text-muted");
              ctx.font = `${10 * devicePixelRatio}px system-ui, sans-serif`;
              // uPlot calls this hook with the right alignment it used for the y-axis ticks, so switch back to left
              ctx.textAlign = "left";
              ctx.textBaseline = "bottom";
              ctx.fillText(b.label, left + 4 * devicePixelRatio, y0 - 2 * devicePixelRatio);
            }
            ctx.restore();
          },
        ],
        draw: [
          (u) => {
            // Write the series name right at the end of each line (text in ink color; the line color identifies the series)
            const ctx = u.ctx;
            ctx.save();
            ctx.font = `${11 * devicePixelRatio}px system-ui, sans-serif`;
            ctx.fillStyle = cssVar("--text-secondary");
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            SERIES.forEach((s, i) => {
              const ys = u.data[i + 1];
              let k = ys.length - 1;
              while (k >= 0 && ys[k] == null) k--;
              if (k < 0) return;
              const x = u.valToPos(u.data[0][k], "x", true);
              const y = u.valToPos(ys[k] as number, "y", true);
              ctx.fillText(s.label, x + 6 * devicePixelRatio, y);
            });
            ctx.restore();
          },
        ],
      },
    };
    const u = new uPlot(opts, data, el);
    plotRef.current = u;
    u.over.addEventListener("mouseenter", () => (pointerInside = true));
    u.over.addEventListener("mouseleave", () => {
      pointerInside = false;
      onHoverRef.current(null);
    });
    // Vertical line shown when hovering over the heatmap
    const line = document.createElement("div");
    Object.assign(line.style, {
      position: "absolute", top: "0", bottom: "0", width: "1px", display: "none", pointerEvents: "none",
      background: cssVar("--text-secondary"), opacity: "0.6",
    });
    u.over.appendChild(line);
    lineRef.current = line;
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height: CHART_HEIGHT }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
      lineRef.current = null;
    };
  }, [schemeKey, lang, cautionUs, warningUs]);

  useEffect(() => {
    plotRef.current?.setData(data);
  }, [data]);

  useEffect(() => {
    const u = plotRef.current;
    const line = lineRef.current;
    if (!u || !line) return;
    if (hoverMs == null || hoverMs < win.startMs || hoverMs > win.endMs) {
      line.style.display = "none";
      return;
    }
    line.style.left = `${u.valToPos(hoverMs / 1000, "x")}px`;
    line.style.display = "block";
  }, [hoverMs, win.startMs, win.endMs]);

  return (
    <div
      ref={wrapRef}
      className="w-full"
      role="img"
      aria-label={t("cpu.chartAria")}
    />
  );
}
