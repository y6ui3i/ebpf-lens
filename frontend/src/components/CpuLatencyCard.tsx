import { useState } from "react";
import type { Sample } from "../types/model";
import { formatUs, percentile, total } from "../lib/hist";
import type { TimeWindow } from "../lib/timeWindow";
import { Heatmap } from "./Heatmap";
import { PercentileChart } from "./PercentileChart";
import { HistogramTable } from "./HistogramTable";
import { useI18n } from "../lib/i18n";

// Heatmap and trend chart of CPU run queue latency
export function CpuLatencyCard({ samples, win, schemeKey }: { samples: Sample[]; win: TimeWindow; schemeKey: string }) {
  const { t } = useI18n();
  const latest = samples.at(-1);
  const [showTable, setShowTable] = useState(false);
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  return (
    <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{t("page.cpu")}</h2>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>Run Queue Latency · runqlat</div>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            {t("cpu.desc")}
          </p>
        </div>
        <div className="text-right text-sm">
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>{t("cpu.lastSecond")}</div>
          <div>
            {t("cpu.p99Pre")}<span className="text-lg font-semibold">{formatUs(latest && percentile(latest.slots, 0.99))}</span>{t("cpu.p99Post")}
          </div>
          <div className="text-xs tabular" style={{ color: "var(--text-secondary)" }}>
            {t("cpu.p50", { p50: formatUs(latest && percentile(latest.slots, 0.5)), n: latest ? total(latest.slots).toLocaleString() : "–" })}
          </div>
        </div>
      </div>

      {/* Side by side on wide screens, stacked on narrow ones. Both x axes cover the same 5 minutes and share the cursor */}
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("cpu.distTitle")}</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("cpu.distNote")}</p>
          <Heatmap samples={samples} win={win} schemeKey={schemeKey} hoverMs={hoverMs} onHover={setHoverMs} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("cpu.trendTitle")}</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>
            {t("cpu.trendNote")}
          </p>
          <PercentileChart samples={samples} win={win} schemeKey={schemeKey} hoverMs={hoverMs} onHover={setHoverMs} />
        </div>
      </div>

      <button className="mt-4 text-xs underline" style={{ color: "var(--text-secondary)" }} onClick={() => setShowTable((v) => !v)}>
        {t(showTable ? "cpu.hideTable" : "cpu.showTable")}
      </button>
      {showTable && <div className="mt-3 max-w-md"><HistogramTable sample={latest} /></div>}
    </section>
  );
}
