import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import type { Sample } from "../types/model";
import type { TimeWindow } from "../lib/timeWindow";
import { cssVar } from "../lib/theme";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_LABEL } from "../lib/lens";
import {
  CAUTION_MS_PER_S, WARNING_MS_PER_S, currentMem, formatBytes, formatMsPerSec, psiMsPerSec, stallMsPerSec, stalledProcs,
} from "../lib/memory";
import { Heatmap, CHART_HEIGHT } from "./Heatmap";

// メモリが足りず、プロセスが自分で空きを作る(回収する)ために止まった時間
export function MemoryPanel({ samples, win, schemeKey }: { samples: Sample[]; win: TimeWindow; schemeKey: string }) {
  const now = currentMem(samples);
  const procs = stalledProcs(samples);
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  return (
    <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
      <h2 className="text-lg font-semibold">メモリ回収による停止</h2>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>Memory reclaim stall · direct / memcg reclaim</div>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        メモリが足りないとき、プロセスが自分で空きを作る(回収する)ために止まった時間
      </p>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Tile label="回収で止まった時間" value={formatMsPerSec(now.stall)} note="全プロセスの合計、直近5秒の中央値(eBPF)" level={now.level} />
        <Tile label="使用率" value={now.used == null ? "–" : `${Math.round(now.used * 100)}%`} note={now.mem ? `全体 ${formatBytes(now.mem.totalBytes)}(/proc/meminfo)` : ""} />
        <Tile label="空き" value={now.mem ? formatBytes(now.mem.availableBytes) : "–"} note="MemAvailable(/proc/meminfo)" />
        <Tile label="PSI some" value={formatMsPerSec(samples.at(-1) ? psiMsPerSec(samples.at(-1)!) : null)} note="答え合わせ用(/proc/pressure/memory)" />
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>1回あたりの停止時間の分布</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>直近5分・1列 = 1秒。何も起きていなければ空</p>
          <Heatmap samples={samples} win={win} schemeKey={schemeKey} hoverMs={hoverMs} onHover={setHoverMs}
            ariaLabel="メモリ回収による停止時間のヒートマップ。横軸が時刻、縦軸が1回あたりの停止時間、色が回数"
            yCaption="1回の回収で止まった時間(上ほど長い)" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>止まった時間の推移(eBPF と PSI)</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>
            注意 {CAUTION_MS_PER_S} ms/秒・警告 {WARNING_MS_PER_S} ms/秒(仮)。PSI は CPU ごとの稼働時間で重み付けした値なので、eBPF より小さく出る
          </p>
          <StallChart samples={samples} win={win} schemeKey={schemeKey} />
        </div>
      </div>

      <div className="mt-6">
        <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>回収で止まったプロセス(直近5分)</h3>
        {procs.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>ありません</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm tabular">
              <thead style={{ color: "var(--text-muted)" }}>
                <tr>
                  <th className="py-1 text-left font-normal">プロセス</th>
                  <th className="py-1 text-right font-normal">止まった合計</th>
                  <th className="py-1 text-right font-normal">回数</th>
                  <th className="py-1 text-right font-normal">1回の最大</th>
                  <th className="py-1 text-right font-normal">回収した量</th>
                  <th className="py-1 text-right font-normal">原因</th>
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
                      {p.memcgCount === p.count ? "cgroup の上限" : p.memcgCount === 0 ? "ホスト全体の不足" : "両方"}
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
  const alert = level && level !== "ok";
  return (
    <div>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</div>
      <div className="flex items-center gap-1.5 text-2xl font-semibold">
        {alert && <span aria-hidden className="text-base" style={{ color: LEVEL_COLOR[level] }}>{LEVEL_ICON[level]}</span>}
        {value}
        {alert && <span className="sr-only">{LEVEL_LABEL[level]}</span>}
      </div>
      <div className="text-xs" style={{ color: "var(--text-secondary)" }}>{note}</div>
    </div>
  );
}

// eBPF の停止時間と PSI some を同じ単位(ms/秒)・同じ軸で並べる
function StallChart({ samples, win, schemeKey }: { samples: Sample[]; win: TimeWindow; schemeKey: string }) {
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
          // 平常時(0)でもしきい値が見えるよう、上端は最低でも警告しきい値の少し上にする
          y: { range: (_u, _min, max) => [0, Math.max(max ?? 0, WARNING_MS_PER_S) * 1.1] },
        },
        axes: [
          {
            ...axis, space: 80,
            values: (_u, vals) => vals.map((v) => new Date(v * 1000).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })),
          },
          { ...axis, size: 60, values: (_u, vals) => vals.map((v) => `${v} ms`) },
        ],
        series: [
          { label: "時刻", value: (_u, v) => (v == null ? "–" : new Date(v * 1000).toLocaleTimeString("ja-JP")) },
          { label: "eBPF(プロセスが止まった時間)", stroke: cssVar("--series-1"), width: 2, points: { show: false }, value: (_u, v) => formatMsPerSec(v) },
          { label: "PSI some(答え合わせ)", stroke: cssVar("--series-2"), width: 2, points: { show: false }, value: (_u, v) => formatMsPerSec(v) },
        ],
        hooks: {
          drawAxes: [
            (u) => {
              const ctx = u.ctx;
              const { left, width } = u.bbox;
              ctx.save();
              for (const [v, color, label] of [
                [CAUTION_MS_PER_S, cssVar("--status-warning"), `注意 ${CAUTION_MS_PER_S} ms/秒`],
                [WARNING_MS_PER_S, cssVar("--status-critical"), `警告 ${WARNING_MS_PER_S} ms/秒`],
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
                // uPlot は y 軸の目盛りを右揃えで描いた状態のまま hook を呼ぶので、左揃えに戻す
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
  }, [schemeKey]);

  useEffect(() => {
    plotRef.current?.setData(data);
  }, [data]);

  return <div ref={wrapRef} className="w-full" role="img" aria-label="メモリ回収で止まった時間の推移。eBPF と PSI を並べたもの" />;
}
