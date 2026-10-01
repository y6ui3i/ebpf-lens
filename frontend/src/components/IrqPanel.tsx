import { useState } from "react";
import type { Sample } from "../types/model";
import type { TimeWindow } from "../lib/timeWindow";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_KEY, type Level } from "../lib/lens";
import { useTriggers } from "../lib/useTriggers";
import { useI18n } from "../lib/i18n";
import { formatUs } from "../lib/hist";
import { cpuRows, currentIrq, irqRows, vecLabel, vecRows } from "../lib/irq";
import { Heatmap } from "./Heatmap";
import { LatencyChart } from "./LatencyChart";

// Interrupts: time the CPUs spend in softirq and hardirq context, per CPU, per vector and per IRQ line.
// `level` is the area's level from the server's irq_busy incidents
export function IrqPanel({ samples, win, schemeKey, level }: { samples: Sample[]; win: TimeWindow; schemeKey: string; level: Level }) {
  const { lang, t } = useI18n();
  const thresholds = useTriggers().irq;
  const now = currentIrq(samples);
  const cpus = cpuRows(samples);
  const vecs = vecRows(samples);
  const irqs = irqRows(samples);
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const pct = (v: number | null | undefined) => (v == null ? "–" : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`);

  if (!now.has) {
    return (
      <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
        <h2 className="text-lg font-semibold">{t("irq.title")}</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>{t("irq.none")}</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
      <h2 className="text-lg font-semibold">{t("irq.title")}</h2>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>softirq_entry/exit · irq_handler_entry/exit · irqlat</div>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{t("irq.desc")}</p>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Tile label={t("irq.tileBusiest")} value={pct(now.busiestShare)} note={t("irq.tileBusiestNote", { cpu: now.busiest ? `cpu${now.busiest.cpu}` : "–", c: Math.round(thresholds.caution * 100) })} level={level} />
        <Tile label={t("irq.tileAll")} value={pct(now.share)} note={t("irq.tileAllNote")} />
        <Tile label={t("irq.tileIrqs")} value={now.irqsPerSec == null ? "–" : Math.round(now.irqsPerSec).toLocaleString()} note={t("irq.tileIrqsNote")} />
        <Tile label={t("irq.tileVec")} value={now.busiest?.topVec || "–"} note={t("irq.tileVecNote")} />
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("irq.distTitle")}</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("irq.distNote")}</p>
          <Heatmap samples={samples} win={win} schemeKey={schemeKey} hoverMs={hoverMs} onHover={setHoverMs}
            ariaLabel={t("irq.heatAria")} yCaption={t("irq.heatYCaption")} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("irq.trendTitle")}</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("irq.trendNote")}</p>
          <LatencyChart samples={samples} win={win} schemeKey={schemeKey} ariaLabel={t("irq.chartAria")} />
        </div>
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-3">
        <div className="min-w-0">
          <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("irq.cpusTitle")}</h3>
          <table className="w-full text-sm tabular">
            <thead style={{ color: "var(--text-muted)" }}>
              <tr>
                <th className="py-1 text-left font-normal">CPU</th>
                <th className="py-1 text-right font-normal">{t("irq.colShare")}</th>
                <th className="py-1 text-right font-normal">softirq</th>
                <th className="py-1 text-right font-normal">irq</th>
                <th className="py-1 text-left font-normal pl-2">{t("irq.colTopVec")}</th>
              </tr>
            </thead>
            <tbody>
              {cpus.map((c) => (
                <tr key={c.cpu} style={{ borderTop: "1px solid var(--grid)" }}>
                  <td className="py-1.5">cpu{c.cpu}</td>
                  <td className="py-1.5 text-right" style={{ color: c.share >= thresholds.caution ? "var(--status-warning)" : "var(--text-primary)" }}>{pct(c.share)}</td>
                  <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatUs(c.softirqNs / 1000)}</td>
                  <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatUs(c.irqNs / 1000)}</td>
                  <td className="py-1.5 pl-2 font-mono text-xs">{c.topVec}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="min-w-0">
          <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("irq.vecsTitle")}</h3>
          <table className="w-full text-sm tabular">
            <thead style={{ color: "var(--text-muted)" }}>
              <tr>
                <th className="py-1 text-left font-normal">{t("irq.colVec")}</th>
                <th className="py-1 text-right font-normal">{t("irq.colCount")}</th>
                <th className="py-1 text-right font-normal">{t("irq.colTotal")}</th>
              </tr>
            </thead>
            <tbody>
              {vecs.map((v) => (
                <tr key={v.vec} style={{ borderTop: "1px solid var(--grid)" }}>
                  <td className="py-1.5"><span className="font-mono text-xs">{v.vec}</span> <span className="text-xs" style={{ color: "var(--text-muted)" }}>{vecLabel(v.vec, lang)}</span></td>
                  <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{v.count.toLocaleString()}</td>
                  <td className="py-1.5 text-right">{formatUs(v.ns / 1000)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="min-w-0">
          <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("irq.irqsTitle")}</h3>
          {irqs.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>{t("common.none")}</p>
          ) : (
            <table className="w-full text-sm tabular">
              <thead style={{ color: "var(--text-muted)" }}>
                <tr>
                  <th className="py-1 text-left font-normal">{t("irq.colIrq")}</th>
                  <th className="py-1 text-right font-normal">{t("irq.colCount")}</th>
                  <th className="py-1 text-right font-normal">{t("irq.colTotal")}</th>
                </tr>
              </thead>
              <tbody>
                {irqs.slice(0, 12).map((q) => (
                  <tr key={q.irq} style={{ borderTop: "1px solid var(--grid)" }}>
                    <td className="py-1.5 break-all"><span className="font-mono text-xs">{q.name}</span> <span className="text-xs" style={{ color: "var(--text-muted)" }}>#{q.irq}</span></td>
                    <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{q.count.toLocaleString()}</td>
                    <td className="py-1.5 text-right">{formatUs(q.ns / 1000)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>{t("irq.note")}</p>
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
