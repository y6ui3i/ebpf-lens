import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { Sample } from "../types/model";
import { formatUs, percentile } from "../lib/hist";
import { cssVar } from "../lib/theme";
import { CAUTION_US, WARNING_US } from "../lib/lens";

const HEIGHT = 240;
const SERIES = [
  { label: "p50", legend: "半数のタスク(p50)", q: 0.5, color: "--series-1" },
  { label: "p99", legend: "99%のタスク(p99)", q: 0.99, color: "--series-2" },
];

export function PercentileChart({ samples, schemeKey }: { samples: Sample[]; schemeKey: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  const data = useMemo<uPlot.AlignedData>(() => {
    const xs = samples.map((s) => Date.parse(s.time) / 1000);
    const ys = SERIES.map(({ q }) => samples.map((s) => percentile(s.slots, q)));
    return [xs, ...ys];
  }, [samples]);

  // テーマが変わったら作り直す(色は生成時に読むため)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const axis = {
      stroke: cssVar("--text-muted"),
      grid: { stroke: cssVar("--grid"), width: 1 },
      ticks: { stroke: cssVar("--axis"), width: 1 },
      font: "11px system-ui, sans-serif",
    };
    const opts: uPlot.Options = {
      width: el.clientWidth,
      height: HEIGHT,
      padding: [8, 40, 0, 0], // 右端に系列名を直接書く余白
      // 縦軸は 1µs〜100ms に固定する。平常時でもしきい値の帯が見えるように
      scales: { x: { time: true }, y: { distr: 3, log: 10, range: () => [1, 100_000] } },
      axes: [
        {
          ...axis,
          space: 70,
          values: (_u, vals) =>
            vals.map((v) => new Date(v * 1000).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })),
        },
        { ...axis, size: 56, values: (_u, vals) => vals.map((v) => formatUs(v)) },
      ],
      series: [
        { label: "時刻", value: (_u, v) => (v == null ? "–" : new Date(v * 1000).toLocaleTimeString("ja-JP")) },
        ...SERIES.map((s) => ({
          label: s.legend,
          stroke: cssVar(s.color),
          width: 2,
          points: { show: false },
          value: (_u: uPlot, v: number | null) => formatUs(v),
        })),
      ],
      cursor: { points: { size: 8 } },
      hooks: {
        // しきい値の帯。軸の後・線の前に描く
        drawAxes: [
          (u) => {
            const ctx = u.ctx;
            const { left, width, top } = u.bbox;
            const yOf = (v: number) => u.valToPos(v, "y", true);
            const bands = [
              { from: CAUTION_US, to: WARNING_US, color: cssVar("--status-warning"), label: `注意 ${formatUs(CAUTION_US)}` },
              { from: WARNING_US, to: 100_000, color: cssVar("--status-critical"), label: `警告 ${formatUs(WARNING_US)}` },
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
              ctx.textBaseline = "bottom";
              ctx.fillText(b.label, left + 4 * devicePixelRatio, y0 - 2 * devicePixelRatio);
            }
            ctx.restore();
          },
        ],
        draw: [
          (u) => {
            // 系列名を線の右端に直接書く(文字色はインク、線の色は系列の識別に任せる)
            const ctx = u.ctx;
            ctx.save();
            ctx.font = `${11 * devicePixelRatio}px system-ui, sans-serif`;
            ctx.fillStyle = cssVar("--text-secondary");
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
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height: HEIGHT }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
    };
  }, [schemeKey]);

  useEffect(() => {
    plotRef.current?.setData(data);
  }, [data]);

  return (
    <div
      ref={wrapRef}
      className="w-full"
      role="img"
      aria-label="run queue レイテンシの p50 と p99 の推移(対数軸)"
    />
  );
}
