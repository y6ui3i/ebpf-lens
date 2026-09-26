import { useState } from "react";
import type { Sample } from "../types/model";
import { formatUs, percentile, total } from "../lib/hist";
import type { TimeWindow } from "../lib/timeWindow";
import { Heatmap } from "./Heatmap";
import { PercentileChart } from "./PercentileChart";
import { HistogramTable } from "./HistogramTable";

// CPU実行待ち時間のヒートマップと推移グラフ
export function CpuLatencyCard({ samples, win, schemeKey }: { samples: Sample[]; win: TimeWindow; schemeKey: string }) {
  const latest = samples.at(-1);
  const [showTable, setShowTable] = useState(false);
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  return (
    <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">CPU実行待ち時間</h2>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>Run Queue Latency · runqlat</div>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            実行可能になったプロセスが、CPUに割り当てられるまでの待ち時間
          </p>
        </div>
        <div className="text-right text-sm">
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>直近1秒</div>
          <div>
            99%のタスクが <span className="text-lg font-semibold">{formatUs(latest && percentile(latest.slots, 0.99))}</span> 以内にCPUを獲得
          </div>
          <div className="text-xs tabular" style={{ color: "var(--text-secondary)" }}>
            半数は {formatUs(latest && percentile(latest.slots, 0.5))} 以内 · 計 {latest ? total(latest.slots).toLocaleString() : "–"} 回
          </div>
        </div>
      </div>

      {/* 広い画面では横に並べ、狭い画面では縦に積む。横軸は同じ 5 分に揃え、カーソルを連動させる */}
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>待ち時間の分布</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>直近5分・1列 = 1秒</p>
          <Heatmap samples={samples} win={win} schemeKey={schemeKey} hoverMs={hoverMs} onHover={setHoverMs} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>待ち時間の推移としきい値</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>
            p99 の線が帯に入っている間は、CPUの取り合いが起きています(しきい値は仮)
          </p>
          <PercentileChart samples={samples} win={win} schemeKey={schemeKey} hoverMs={hoverMs} onHover={setHoverMs} />
        </div>
      </div>

      <button className="mt-4 text-xs underline" style={{ color: "var(--text-secondary)" }} onClick={() => setShowTable((v) => !v)}>
        {showTable ? "表を閉じる" : "直近のヒストグラムを表で見る"}
      </button>
      {showTable && <div className="mt-3 max-w-md"><HistogramTable sample={latest} /></div>}
    </section>
  );
}
