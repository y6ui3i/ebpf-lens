import { useState } from "react";
import type { Sample } from "../types/model";
import type { TimeWindow } from "../lib/timeWindow";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_KEY, type Level } from "../lib/lens";
import { useTriggers } from "../lib/useTriggers";
import { useI18n } from "../lib/i18n";
import { formatUs } from "../lib/hist";
import { currentFiles, errExplain, errRows, fsyncRows, openFailRows, syncerRows, type FileTier } from "../lib/files";
import { Heatmap } from "./Heatmap";
import { LatencyChart } from "./LatencyChart";

// Files: opens that failed (who, which path, which errno) and fsync waits (how long, on which file, who waited).
// `level` is the area's level from the server's file_fail / fsync_slow incidents
export function FilesPanel({ samples, win, schemeKey, level }: { samples: Sample[]; win: TimeWindow; schemeKey: string; level: Level }) {
  const { lang, t } = useI18n();
  const thresholds = useTriggers().files;
  const now = currentFiles(samples);
  const fails = openFailRows(samples).filter((r) => r.tier !== "noise");
  const errs = errRows(samples);
  const fsyncs = fsyncRows(samples);
  const syncers = syncerRows(samples);
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  if (!now.has) {
    return (
      <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
        <h2 className="text-lg font-semibold">{t("files.title")}</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>{t("files.none")}</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
      <h2 className="text-lg font-semibold">{t("files.title")}</h2>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>open / fsync · fileops</div>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{t("files.desc")}</p>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Tile label={t("files.tileFails")} value={`${now.fails}`} note={t("files.tileFailsNote", { all: now.allFails.toLocaleString() })} level={now.fails > 0 ? "caution" : undefined} />
        <Tile label={t("files.tileFsyncs")} value={now.fsyncsPerSec == null ? "–" : now.fsyncsPerSec.toFixed(1)} note={t("files.tileFsyncsNote")} />
        <Tile label={t("files.tileP99")} value={formatUs(now.p99)} note={t("files.tileP99Note")} level={level} />
        <Tile label={t("files.tileFiles")} value={`${fsyncs.length}`} note={t("files.tileFilesNote")} />
      </div>

      <div className="mt-6">
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("files.failsTitle")}</h3>
        <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("files.failsNote")}</p>
        {errs.length > 0 && (
          <ul className="mb-3 flex flex-wrap gap-1.5 text-xs" aria-label={t("files.byErrno")}>
            {errs.map((e) => (
              <li key={e.error} title={errExplain(e.error, lang)} className="rounded-md px-2 py-0.5 tabular" style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
                <span className="font-mono">{e.error}</span> {e.count.toLocaleString()}
              </li>
            ))}
          </ul>
        )}
        {fails.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>{t("files.failsNone")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm tabular">
              <thead style={{ color: "var(--text-muted)" }}>
                <tr>
                  <th className="py-1 text-left font-normal">{t("common.process")}</th>
                  <th className="py-1 text-left font-normal">{t("files.colPath")}</th>
                  <th className="py-1 text-left font-normal">{t("files.colError")}</th>
                  <th className="py-1 text-right font-normal">{t("files.colCount")}</th>
                </tr>
              </thead>
              <tbody>
                {fails.slice(0, 15).map((f) => (
                  <tr key={f.key} style={{ borderTop: "1px solid var(--grid)" }}>
                    <td className="py-1.5 whitespace-nowrap">
                      <span aria-hidden className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: TIER_COLOR[f.tier] }} />
                      {f.comm}
                    </td>
                    <td className="py-1.5 break-all font-mono text-xs">{f.path}</td>
                    <td className="py-1.5 whitespace-nowrap" title={f.error}>
                      <span className="font-mono text-xs">{f.error}</span>
                      <span className="ml-1 text-xs" style={{ color: f.tier === "trouble" ? "var(--status-warning)" : "var(--text-muted)" }}>{errExplain(f.error, lang)}</span>
                    </td>
                    <td className="py-1.5 text-right" style={{ color: f.tier === "trouble" ? "var(--status-warning)" : "var(--text-secondary)" }}>{f.count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("files.failsLimit")}</p>
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("files.distTitle")}</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("files.distNote")}</p>
          <Heatmap samples={samples} win={win} schemeKey={schemeKey} hoverMs={hoverMs} onHover={setHoverMs}
            ariaLabel={t("files.heatAria")} yCaption={t("files.heatYCaption")} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("files.trendTitle")}</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>
            {t("files.trendNote", { c: formatUs(thresholds.fsyncLatency.caution), w: formatUs(thresholds.fsyncLatency.warning) })}
          </p>
          <LatencyChart samples={samples} win={win} schemeKey={schemeKey} caution={thresholds.fsyncLatency.caution} warning={thresholds.fsyncLatency.warning} ariaLabel={t("files.chartAria")} />
        </div>
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("files.fsyncTitle")}</h3>
          {fsyncs.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>{t("common.none")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[26rem] text-sm tabular">
                <thead style={{ color: "var(--text-muted)" }}>
                  <tr>
                    <th className="py-1 text-left font-normal">{t("files.colFile")}</th>
                    <th className="py-1 text-right font-normal">{t("files.colFsyncs")}</th>
                    <th className="py-1 text-right font-normal">{t("files.colTotal")}</th>
                    <th className="py-1 text-right font-normal">{t("files.colAvg")}</th>
                    <th className="py-1 text-right font-normal">{t("files.colMax")}</th>
                  </tr>
                </thead>
                <tbody>
                  {fsyncs.slice(0, 12).map((f) => (
                    <tr key={f.name} style={{ borderTop: "1px solid var(--grid)" }}>
                      <td className="py-1.5 break-all font-mono text-xs">{f.name}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{f.fsyncs.toLocaleString()}</td>
                      <td className="py-1.5 text-right">{formatUs(f.totalNs / 1000)}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatUs(f.avgNs / 1000)}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatUs(f.maxNs / 1000)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="min-w-0">
          <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("files.procsTitle")}</h3>
          {syncers.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>{t("common.none")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[24rem] text-sm tabular">
                <thead style={{ color: "var(--text-muted)" }}>
                  <tr>
                    <th className="py-1 text-left font-normal">{t("common.process")}</th>
                    <th className="py-1 text-right font-normal">{t("files.colFsyncs")}</th>
                    <th className="py-1 text-right font-normal">p99</th>
                    <th className="py-1 text-right font-normal">{t("files.colMax")}</th>
                    <th className="py-1 text-right font-normal">{t("files.colOpenFails")}</th>
                  </tr>
                </thead>
                <tbody>
                  {syncers.slice(0, 10).map((p) => (
                    <tr key={p.comm} style={{ borderTop: "1px solid var(--grid)" }}>
                      <td className="py-1.5">{p.procs > 1 ? `${p.comm} ×${p.procs}` : p.comm}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{p.fsyncs.toLocaleString()}</td>
                      <td className="py-1.5 text-right">{formatUs(p.p99)}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{p.fsyncs ? formatUs(p.maxNs / 1000) : "–"}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{p.openFails.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("files.procsNote")}</p>
        </div>
      </div>
    </section>
  );
}

// Trouble in the warning color, notable in the caution color
const TIER_COLOR: Record<FileTier, string> = { trouble: LEVEL_COLOR.warning, notable: LEVEL_COLOR.caution, noise: "var(--border)" };

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
