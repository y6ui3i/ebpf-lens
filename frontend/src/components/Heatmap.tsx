import { useEffect, useRef, useState } from "react";
import type { Sample } from "../types/model";
import { formatRange } from "../lib/hist";
import { cssVar } from "../lib/theme";

// 表示するスロットは 0..TOP。TOP 行は 2^TOP µs(約 1 秒)以上をまとめる
const TOP = 20;
const ROWS = TOP + 1;
const HEAT_STEPS = 13;
const MARGIN = { left: 56, right: 8, top: 8, bottom: 22 };
const HEIGHT = 300;
// y 軸に出すスロット(1µs, 8µs, 128µs, 1ms, 8ms, 131ms, 1s)
const Y_TICKS: [number, string][] = [
  [0, "1µs"], [3, "8µs"], [7, "128µs"], [10, "1ms"], [13, "8ms"], [17, "131ms"], [20, "≥1s"],
];

type Hover = { x: number; y: number; sample: Sample; row: number; count: number };

export function Heatmap({ samples, columns, schemeKey }: { samples: Sample[]; columns: number; schemeKey: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<Hover | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const colW = plotW / columns;
  const rowH = plotH / ROWS;
  const offset = columns - samples.length; // 最新を右端に寄せる

  const rowCount = (s: Sample, row: number) =>
    row < TOP ? (s.slots[row] ?? 0) : s.slots.slice(TOP).reduce((a, b) => a + b, 0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = HEIGHT * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);

    const ramp = Array.from({ length: HEAT_STEPS }, (_, i) => cssVar(`--heat-${i}`));
    let max = 0;
    for (const s of samples) for (let r = 0; r < ROWS; r++) max = Math.max(max, rowCount(s, r));
    const logMax = Math.log1p(max);

    samples.forEach((s, j) => {
      const x = MARGIN.left + (offset + j) * colW;
      for (let r = 0; r < ROWS; r++) {
        const c = rowCount(s, r);
        if (c === 0) continue; // ゼロは面の色のまま
        const t = Math.log1p(c) / logMax;
        ctx.fillStyle = ramp[Math.min(HEAT_STEPS - 1, Math.ceil(t * HEAT_STEPS) - 1)];
        const y = MARGIN.top + (TOP - r) * rowH;
        ctx.fillRect(x, y, Math.ceil(colW), Math.ceil(rowH));
      }
    });

    // 軸
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = cssVar("--text-muted");
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const [slot, label] of Y_TICKS) {
      ctx.fillText(label, MARGIN.left - 6, MARGIN.top + (TOP - slot) * rowH + rowH / 2);
    }
    ctx.strokeStyle = cssVar("--axis");
    ctx.beginPath();
    ctx.moveTo(MARGIN.left, MARGIN.top + plotH + 0.5);
    ctx.lineTo(MARGIN.left + plotW, MARGIN.top + plotH + 0.5);
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    samples.forEach((s, j) => {
      const d = new Date(s.time);
      if (d.getSeconds() % 60 !== 0) return; // 1 分ごとに目盛り
      const x = MARGIN.left + (offset + j + 0.5) * colW;
      ctx.fillText(d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }), x, MARGIN.top + plotH + 6);
    });
  }, [samples, width, columns, schemeKey]);

  const onMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const j = Math.floor((x - MARGIN.left) / colW) - offset;
    const row = TOP - Math.floor((y - MARGIN.top) / rowH);
    const sample = samples[j];
    if (!sample || row < 0 || row > TOP) return setHover(null);
    setHover({ x, y, sample, row, count: rowCount(sample, row) });
  };

  return (
    <div ref={wrapRef} className="relative w-full">
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: HEIGHT, display: "block" }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="run queue レイテンシのヒートマップ。横軸が時刻、縦軸が待ち時間、色の濃さが件数"
      />
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md px-2.5 py-1.5 text-xs shadow-md tabular"
          style={{
            left: Math.min(hover.x + 12, width - 180),
            top: Math.max(0, hover.y - 56),
            background: "var(--surface-1)",
            border: "1px solid var(--border)",
          }}
        >
          <div style={{ color: "var(--text-muted)" }}>{new Date(hover.sample.time).toLocaleTimeString("ja-JP")}</div>
          <div style={{ color: "var(--text-secondary)" }}>
            {hover.row === TOP ? "≥ 1 s" : formatRange(hover.row)}
          </div>
          <div style={{ color: "var(--text-primary)" }} className="font-semibold">
            {hover.count.toLocaleString()} 件
          </div>
        </div>
      )}
      <HeatLegend schemeKey={schemeKey} />
    </div>
  );
}

// 軸と色の意味をそのまま書く。runqlat を知らない人が読めることを優先する
function HeatLegend({ schemeKey }: { schemeKey: string }) {
  const stops = Array.from({ length: HEAT_STEPS }, (_, i) => `var(--heat-${i})`).join(", ");
  const more = schemeKey === "dark" ? "明るいほど多い" : "濃いほど多い";
  return (
    <dl
      className="mt-3 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-3"
      style={{ color: "var(--text-secondary)", paddingLeft: MARGIN.left }}
    >
      <div><dt className="inline" style={{ color: "var(--text-muted)" }}>横軸 </dt><dd className="inline">いつ発生したか</dd></div>
      <div><dt className="inline" style={{ color: "var(--text-muted)" }}>縦軸 </dt><dd className="inline">CPUを待った時間(上ほど長い)</dd></div>
      <div className="flex items-center gap-2">
        <dt style={{ color: "var(--text-muted)" }}>色</dt>
        <dd className="flex items-center gap-2">
          <span>その待ち時間が起きた回数({more})</span>
          <span aria-hidden className="h-2 w-16 shrink-0 rounded-sm" style={{ background: `linear-gradient(to right, ${stops})` }} />
        </dd>
      </div>
    </dl>
  );
}
