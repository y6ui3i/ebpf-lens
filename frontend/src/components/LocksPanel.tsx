import { useState } from "react";
import type { Sample } from "../types/model";
import type { TimeWindow } from "../lib/timeWindow";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_KEY, type Level } from "../lib/lens";
import { useTriggers } from "../lib/useTriggers";
import { useI18n } from "../lib/i18n";
import { formatUs } from "../lib/hist";
import { currentLocks, kindLabel, kindRows, waiterRows } from "../lib/locks";
import { Heatmap } from "./Heatmap";
import { LatencyChart } from "./LatencyChart";

// Locks: time blocked on contended user-space locks (futex) and on kernel locks, per process and per kind.
// `level` is the area's level from the server's lock_wait incidents
export function LocksPanel({ samples, win, schemeKey, level }: { samples: Sample[]; win: TimeWindow; schemeKey: string; level: Level }) {
  const { lang, t } = useI18n();
  const thresholds = useTriggers().locks;
  const now = currentLocks(samples);
  const waiters = waiterRows(samples);
  const kinds = kindRows(samples);
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  if (!now.has) {
    return (
      <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
        <h2 className="text-lg font-semibold">{t("locks.title")}</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>{t("locks.none")}</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
      <h2 className="text-lg font-semibold">{t("locks.title")}</h2>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>futex · lock:contention · lockwait</div>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{t("locks.desc")}</p>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Tile label={t("locks.tileSec")} value={now.secPerSec == null ? "–" : now.secPerSec.toFixed(2)} note={t("locks.tileSecNote", { c: thresholds.caution.toFixed(1) })} level={level} />
        <Tile label={t("locks.tileWaits")} value={now.waitsPerSec == null ? "–" : Math.round(now.waitsPerSec).toLocaleString()} note={t("locks.tileWaitsNote")} />
        <Tile label={t("locks.tileP99")} value={formatUs(now.p99)} note={t("locks.tileP99Note")} />
        <Tile label={t("locks.tileKernel")} value={formatUs(now.kernelNs / 1000 / 5)} note={t("locks.tileKernelNote")} />
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("locks.distTitle")}</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("locks.distNote")}</p>
          <Heatmap samples={samples} win={win} schemeKey={schemeKey} hoverMs={hoverMs} onHover={setHoverMs}
            ariaLabel={t("locks.heatAria")} yCaption={t("locks.heatYCaption")} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("locks.trendTitle")}</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("locks.trendNote")}</p>
          <LatencyChart samples={samples} win={win} schemeKey={schemeKey} ariaLabel={t("locks.chartAria")} />
        </div>
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("locks.procsTitle")}</h3>
          {waiters.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>{t("common.none")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-sm tabular">
                <thead style={{ color: "var(--text-muted)" }}>
                  <tr>
                    <th className="py-1 text-left font-normal">{t("common.process")}</th>
                    <th className="py-1 text-right font-normal">{t("locks.colSec")}</th>
                    <th className="py-1 text-right font-normal">{t("locks.colLocks")}</th>
                    <th className="py-1 text-right font-normal">{t("locks.colWaits")}</th>
                    <th className="py-1 text-right font-normal">{t("locks.colUser")}</th>
                    <th className="py-1 text-right font-normal">p99</th>
                    <th className="py-1 text-right font-normal">{t("locks.colKernel")}</th>
                  </tr>
                </thead>
                <tbody>
                  {waiters.slice(0, 12).map((p) => (
                    <tr key={p.comm} style={{ borderTop: "1px solid var(--grid)" }}>
                      <td className="py-1.5">{p.procs > 1 ? `${p.comm} ×${p.procs}` : p.comm}</td>
                      <td className="py-1.5 text-right" style={{ color: p.secPerSec >= thresholds.caution ? "var(--status-warning)" : "var(--text-primary)" }}>{p.secPerSec.toFixed(2)}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{p.locks}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{p.waits.toLocaleString()}</td>
                      <td className="py-1.5 text-right">{formatUs(p.userNs / 1000)}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatUs(p.p99)}</td>
                      <td className="py-1.5 text-right">{p.kernelCount ? `${formatUs(p.kernelNs / 1000)} · ${p.kernelCount.toLocaleString()}` : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("locks.procsNote")}</p>
        </div>
        <div className="min-w-0">
          <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("locks.kindsTitle")}</h3>
          {kinds.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>{t("common.none")}</p>
          ) : (
            <table className="w-full text-sm tabular">
              <thead style={{ color: "var(--text-muted)" }}>
                <tr>
                  <th className="py-1 text-left font-normal">{t("locks.colKind")}</th>
                  <th className="py-1 text-right font-normal">{t("locks.colWaits")}</th>
                  <th className="py-1 text-right font-normal">{t("locks.colTotal")}</th>
                </tr>
              </thead>
              <tbody>
                {kinds.map((k) => (
                  <tr key={k.kind} style={{ borderTop: "1px solid var(--grid)" }}>
                    <td className="py-1.5" title={k.kind}>{kindLabel(k.kind, lang)}</td>
                    <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{k.count.toLocaleString()}</td>
                    <td className="py-1.5 text-right">{formatUs(k.latNs / 1000)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("locks.kindsNote")}</p>
        </div>
      </div>
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
