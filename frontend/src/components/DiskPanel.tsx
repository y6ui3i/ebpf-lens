import { useState } from "react";
import type { Sample } from "../types/model";
import type { TimeWindow } from "../lib/timeWindow";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_KEY, type Level } from "../lib/lens";
import { useTriggers } from "../lib/useTriggers";
import { useI18n } from "../lib/i18n";
import { formatUs } from "../lib/hist";
import { formatBytes } from "../lib/memory";
import { currentDisk, deviceRows, formatRate, issuerRows } from "../lib/disk";
import { Heatmap } from "./Heatmap";
import { LatencyChart } from "./LatencyChart";

// Block I/O: latency from issue to completion (eBPF), per device and per issuing process.
// `level` is the disk area's level from the server's disk_slow / disk_error incidents
export function DiskPanel({ samples, win, schemeKey, level }: { samples: Sample[]; win: TimeWindow; schemeKey: string; level: Level }) {
  const { t } = useI18n();
  const thresholds = useTriggers().disk; // µs, the same numbers the server judges with
  const now = currentDisk(samples);
  const devices = deviceRows(samples);
  const issuers = issuerRows(samples);
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  return (
    <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
      <h2 className="text-lg font-semibold">{t("disk.title")}</h2>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>Block I/O latency · biolat</div>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{t("disk.desc")}</p>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Tile label={t("disk.tileP99")} value={formatUs(now.p99)} note={t("disk.tileP99Note")} level={level} />
        <Tile label={t("disk.tileRate")} value={formatRate(now.bytesPerSec)} note={t("disk.tileRateNote")} />
        <Tile label={t("disk.tileIops")} value={now.iops == null ? "–" : Math.round(now.iops).toLocaleString()} note={t("disk.tileIopsNote")} />
        <Tile label={t("disk.tileErrors")} value={`${now.errors}`} note={t("disk.tileErrorsNote")} level={now.errors > 0 ? "warning" : undefined} />
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("disk.distTitle")}</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("disk.distNote")}</p>
          <Heatmap samples={samples} win={win} schemeKey={schemeKey} hoverMs={hoverMs} onHover={setHoverMs}
            ariaLabel={t("disk.heatAria")} yCaption={t("disk.heatYCaption")} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("disk.trendTitle")}</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>
            {t("disk.trendNote", { c: formatUs(thresholds.caution), w: formatUs(thresholds.warning) })}
          </p>
          <LatencyChart samples={samples} win={win} schemeKey={schemeKey} caution={thresholds.caution} warning={thresholds.warning} ariaLabel={t("disk.chartAria")} />
        </div>
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("disk.devsTitle")}</h3>
          {devices.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>{t("common.none")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[26rem] text-sm tabular">
                <thead style={{ color: "var(--text-muted)" }}>
                  <tr>
                    <th className="py-1 text-left font-normal">{t("disk.colDevice")}</th>
                    <th className="py-1 text-right font-normal">{t("disk.colRead")}</th>
                    <th className="py-1 text-right font-normal">{t("disk.colWrite")}</th>
                    <th className="py-1 text-right font-normal">{t("disk.colP99")}</th>
                    <th className="py-1 text-right font-normal">{t("disk.colMax")}</th>
                    <th className="py-1 text-right font-normal">{t("disk.colErrors")}</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.slice(0, 8).map((d) => (
                    <tr key={d.name} style={{ borderTop: "1px solid var(--grid)" }}>
                      <td className="py-1.5">{d.name}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatBytes(d.readBytes)}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatBytes(d.writeBytes)}</td>
                      <td className="py-1.5 text-right">{formatUs(d.p99)}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatUs(d.maxNs / 1000)}</td>
                      <td className="py-1.5 text-right" style={{ color: d.errors ? "var(--status-critical)" : "var(--text-secondary)" }}>{d.errors}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="min-w-0">
          <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("disk.procsTitle")}</h3>
          {issuers.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>{t("common.none")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[26rem] text-sm tabular">
                <thead style={{ color: "var(--text-muted)" }}>
                  <tr>
                    <th className="py-1 text-left font-normal">{t("common.process")}</th>
                    <th className="py-1 text-right font-normal">{t("disk.colRead")}</th>
                    <th className="py-1 text-right font-normal">{t("disk.colWrite")}</th>
                    <th className="py-1 text-right font-normal">{t("disk.colIos")}</th>
                    <th className="py-1 text-right font-normal">{t("disk.colP99")}</th>
                    <th className="py-1 text-right font-normal">{t("disk.colMax")}</th>
                  </tr>
                </thead>
                <tbody>
                  {issuers.slice(0, 8).map((p) => (
                    <tr key={p.comm} style={{ borderTop: "1px solid var(--grid)" }}>
                      <td className="py-1.5">{p.procs > 1 ? `${p.comm} ×${p.procs}` : p.comm}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatBytes(p.readBytes)}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatBytes(p.writeBytes)}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{p.ios.toLocaleString()}</td>
                      <td className="py-1.5 text-right">{formatUs(p.p99)}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatUs(p.maxNs / 1000)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("disk.procsNote")}</p>
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
