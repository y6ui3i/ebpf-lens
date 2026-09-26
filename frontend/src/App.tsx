import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { HostInfo } from "./types/model";
import { useLiveSamples, type StreamStatus } from "./lib/useLiveSamples";
import { useColorSchemeKey } from "./lib/theme";
import { formatUs, percentile, total } from "./lib/hist";
import { Heatmap } from "./components/Heatmap";
import { PercentileChart } from "./components/PercentileChart";
import { HistogramTable } from "./components/HistogramTable";
import { LensSummary } from "./components/LensSummary";
import { ImpactPanel } from "./components/ImpactPanel";

const WINDOW = 300; // 直近 5 分(1 秒 1 列)

export default function App() {
  const schemeKey = useColorSchemeKey();
  const hosts = useQuery({
    queryKey: ["hosts"],
    queryFn: () => fetch("/api/hosts").then((r) => r.json() as Promise<HostInfo[]>),
    refetchInterval: 5000,
  });
  const [picked, setPicked] = useState<string>();
  const host = picked ?? hosts.data?.[0]?.name;
  const { samples, status } = useLiveSamples(host, "runqlat", WINDOW);
  const latest = samples.at(-1);
  const [showTable, setShowTable] = useState(false);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">eBPFLens</h1>
        <select
          className="rounded-md px-2 py-1 text-sm"
          style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
          value={host ?? ""}
          onChange={(e) => setPicked(e.target.value)}
          aria-label="ホスト"
        >
          {hosts.data?.length ? null : <option value="">ホストなし</option>}
          {hosts.data?.map((h) => (
            <option key={h.name} value={h.name}>{h.name}</option>
          ))}
        </select>
        {host && <StatusBadge status={status} />}
      </header>

      {!host ? (
        <p style={{ color: "var(--text-secondary)" }}>
          エージェントからのデータを待っています。<code>ebpflens-agent -server …</code> を起動してください。
        </p>
      ) : (
        <>
        <LensSummary samples={samples} />
        <ImpactPanel samples={samples} />
        <section
          className="rounded-xl p-5"
          style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
        >
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

          <h3 className="mb-2 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>
            待ち時間の分布(直近5分・1列 = 1秒)
          </h3>
          <Heatmap samples={samples} columns={WINDOW} schemeKey={schemeKey} />

          <h3 className="mt-8 mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>
            待ち時間の推移としきい値
          </h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>
            p99 の線が帯に入っている間は、CPUの取り合いが起きています(しきい値は仮)
          </p>
          <PercentileChart samples={samples} schemeKey={schemeKey} />

          <button
            className="mt-4 text-xs underline"
            style={{ color: "var(--text-secondary)" }}
            onClick={() => setShowTable((v) => !v)}
          >
            {showTable ? "表を閉じる" : "直近のヒストグラムを表で見る"}
          </button>
          {showTable && <div className="mt-3 max-w-md"><HistogramTable sample={latest} /></div>}
        </section>
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: StreamStatus }) {
  const live = status === "live";
  return (
    <span className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
      <span aria-hidden style={{ color: live ? "var(--status-good)" : "var(--status-critical)" }}>
        {live ? "●" : "○"}
      </span>
      {live ? "ライブ" : status === "connecting" ? "接続中" : "再接続中"}
    </span>
  );
}
