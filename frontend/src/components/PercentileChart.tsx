import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { Sample } from "../types/model";
import { formatUs, percentile } from "../lib/hist";
import { cssVar } from "../lib/theme";
import { CAUTION_US, WARNING_US } from "../lib/lens";
import type { TimeWindow } from "../lib/timeWindow";
import { CHART_HEIGHT } from "./Heatmap";

const SERIES = [
  { label: "p50", legend: "半数のタスク(p50)", q: 0.5, color: "--series-1" },
  { label: "p99", legend: "99%のタスク(p99)", q: 0.99, color: "--series-2" },
];

type Props = {
  samples: Sample[];
  win: TimeWindow;
  schemeKey: string;
  hoverMs: number | null; // ヒートマップと共有するカーソル時刻
  onHover: (ms: number | null) => void;
};

export function PercentileChart({ samples, win, schemeKey, hoverMs, onHover }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const lineRef = useRef<HTMLDivElement | null>(null);
  // uPlot のコールバックは生成時に固定されるので、最新の値は ref 経由で読む
  const winRef = useRef(win);
  winRef.current = win;
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;

  const data = useMemo<uPlot.AlignedData>(() => {
    const xs = samples.map((s) => Date.parse(s.time) / 1000);
    const ys = SERIES.map(({ q }) => samples.map((s) => percentile(s.slots, q)));
    return [xs, ...ys];
  }, [samples]);

  // テーマが変わったら作り直す(色は生成時に読むため)
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
      padding: [8, 40, 0, 0], // 右端に系列名を直接書く余白
      scales: {
        // 横軸はヒートマップと同じ範囲に固定する
        x: { time: true, range: () => [winRef.current.startMs / 1000, winRef.current.endMs / 1000] },
        // 縦軸は 1µs〜100ms に固定する。平常時でもしきい値の帯が見えるように
        y: { distr: 3, log: 10, range: () => [1, 100_000] },
      },
      axes: [
        {
          ...axis,
          space: 80,
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
        setCursor: [
          (u) => {
            // データ更新でも呼ばれるので、マウスがこのグラフ上にあるときだけ連動させる
            if (!pointerInside) return;
            const left = u.cursor.left;
            onHoverRef.current(left == null || left < 0 ? null : u.posToVal(left, "x") * 1000);
          },
        ],
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
    u.over.addEventListener("mouseenter", () => (pointerInside = true));
    u.over.addEventListener("mouseleave", () => {
      pointerInside = false;
      onHoverRef.current(null);
    });
    // ヒートマップ側でホバーしたときに出す縦線
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
  }, [schemeKey]);

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
      aria-label="CPU実行待ち時間の p50 と p99 の推移(対数軸)"
    />
  );
}
