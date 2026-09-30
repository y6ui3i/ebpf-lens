import { useState } from "react";
import type { Sample } from "../types/model";
import type { TimeWindow } from "../lib/timeWindow";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_KEY, type Level } from "../lib/lens";
import { useTriggers } from "../lib/useTriggers";
import { useI18n } from "../lib/i18n";
import { formatUs } from "../lib/hist";
import { connectorRows, currentNet, destRows, dropExplain, dropFlowRows, dropReasonRows, type DropTier } from "../lib/net";
import { Heatmap } from "./Heatmap";
import { LatencyChart } from "./LatencyChart";

// Outbound TCP: connect latency, failed connects and retransmissions, per destination and per process.
// `level` is the network area's level from the server's net_* incidents
export function NetworkPanel({ samples, win, schemeKey, level }: { samples: Sample[]; win: TimeWindow; schemeKey: string; level: Level }) {
  const { lang, t } = useI18n();
  const thresholds = useTriggers().network;
  const now = currentNet(samples);
  const dests = destRows(samples);
  const connectors = connectorRows(samples);
  const dropReasons = dropReasonRows(samples);
  const dropFlows = dropFlowRows(samples);
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  return (
    <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
      <h2 className="text-lg font-semibold">{t("net.title")}</h2>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>TCP connect / retransmit · tcpconn</div>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{t("net.desc")}</p>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Tile label={t("net.tileConnects")} value={now.connectsPerSec == null ? "–" : now.connectsPerSec.toFixed(1)} note={t("net.tileConnectsNote")} />
        <Tile label={t("net.tileP99")} value={formatUs(now.p99)} note={t("net.tileP99Note")} level={level} />
        <Tile label={t("net.tileFails")} value={`${now.fails}`} note={t("net.tileFailsNote")} level={now.fails > 0 ? "caution" : undefined} />
        <Tile label={t("net.tileRetrans")} value={`${now.retrans}`} note={t("net.tileRetransNote")} level={now.retrans > 0 ? "caution" : undefined} />
        <Tile label={t("net.tileDrops")} value={`${now.drops}`} note={t("net.tileDropsNote")} level={now.drops > 0 ? "caution" : undefined} />
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("net.distTitle")}</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("net.distNote")}</p>
          <Heatmap samples={samples} win={win} schemeKey={schemeKey} hoverMs={hoverMs} onHover={setHoverMs}
            ariaLabel={t("net.heatAria")} yCaption={t("net.heatYCaption")} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("net.trendTitle")}</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>
            {t("net.trendNote", { c: formatUs(thresholds.connectLatency.caution), w: formatUs(thresholds.connectLatency.warning) })}
          </p>
          <LatencyChart samples={samples} win={win} schemeKey={schemeKey} caution={thresholds.connectLatency.caution} warning={thresholds.connectLatency.warning} ariaLabel={t("net.chartAria")} />
        </div>
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("net.destsTitle")}</h3>
          {dests.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>{t("common.none")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[28rem] text-sm tabular">
                <thead style={{ color: "var(--text-muted)" }}>
                  <tr>
                    <th className="py-1 text-left font-normal">{t("net.colDest")}</th>
                    <th className="py-1 text-right font-normal">{t("net.colConnects")}</th>
                    <th className="py-1 text-right font-normal">{t("net.colFails")}</th>
                    <th className="py-1 text-right font-normal">{t("net.colRetrans")}</th>
                    <th className="py-1 text-right font-normal">{t("net.colAvg")}</th>
                    <th className="py-1 text-right font-normal">{t("net.colMax")}</th>
                  </tr>
                </thead>
                <tbody>
                  {dests.slice(0, 10).map((d) => (
                    <tr key={d.dest} style={{ borderTop: "1px solid var(--grid)" }}>
                      <td className="py-1.5 whitespace-nowrap">{d.dest}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{d.connects.toLocaleString()}</td>
                      <td className="py-1.5 text-right" style={{ color: d.fails ? "var(--status-warning)" : "var(--text-secondary)" }}>{d.fails}</td>
                      <td className="py-1.5 text-right" style={{ color: d.retrans ? "var(--status-warning)" : "var(--text-secondary)" }}>{d.retrans}</td>
                      <td className="py-1.5 text-right">{d.connects ? formatUs(d.avgNs / 1000) : "–"}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{d.connects ? formatUs(d.maxNs / 1000) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="min-w-0">
          <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("net.procsTitle")}</h3>
          {connectors.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>{t("common.none")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[24rem] text-sm tabular">
                <thead style={{ color: "var(--text-muted)" }}>
                  <tr>
                    <th className="py-1 text-left font-normal">{t("common.process")}</th>
                    <th className="py-1 text-right font-normal">{t("net.colConnects")}</th>
                    <th className="py-1 text-right font-normal">{t("net.colFails")}</th>
                    <th className="py-1 text-right font-normal">p99</th>
                    <th className="py-1 text-right font-normal">{t("net.colMax")}</th>
                  </tr>
                </thead>
                <tbody>
                  {connectors.slice(0, 10).map((p) => (
                    <tr key={p.comm} style={{ borderTop: "1px solid var(--grid)" }}>
                      <td className="py-1.5">{p.procs > 1 ? `${p.comm} ×${p.procs}` : p.comm}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{p.connects.toLocaleString()}</td>
                      <td className="py-1.5 text-right" style={{ color: p.fails ? "var(--status-warning)" : "var(--text-secondary)" }}>{p.fails}</td>
                      <td className="py-1.5 text-right">{formatUs(p.p99)}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{p.connects ? formatUs(p.maxNs / 1000) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("net.procsNote")}</p>
        </div>
      </div>

      <div className="mt-6">
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("net.dropsTitle")}</h3>
        <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("net.dropsNote")}</p>
        {dropReasons.length > 0 && (
          <ul className="mb-3 flex flex-wrap gap-1.5 text-xs" aria-label={t("net.dropReasons")}>
            {dropReasons.map((r) => (
              <li
                key={r.reason}
                title={dropExplain(r.reason, lang)}
                className="rounded-md px-2 py-0.5 tabular"
                style={{ border: `1px solid ${TIER_BORDER[r.tier]}`, color: r.tier === "noise" ? "var(--text-muted)" : "var(--text-primary)" }}
              >
                <span className="font-mono">{r.reason}</span> {r.count.toLocaleString()}
                <span className="ml-1" style={{ color: "var(--text-muted)" }}>· {t(`net.tier.${r.tier}` as const)}</span>
              </li>
            ))}
          </ul>
        )}
        {dropFlows.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>{t("net.dropsNone")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm tabular">
              <thead style={{ color: "var(--text-muted)" }}>
                <tr>
                  <th className="py-1 text-left font-normal">{t("net.colReason")}</th>
                  <th className="py-1 text-left font-normal">{t("net.colFrom")}</th>
                  <th className="py-1 text-left font-normal">{t("net.colTo")}</th>
                  <th className="py-1 text-left font-normal">{t("net.colListener")}</th>
                  <th className="py-1 text-right font-normal">{t("net.colCount")}</th>
                </tr>
              </thead>
              <tbody>
                {dropFlows.slice(0, 15).map((f) => (
                  <tr key={f.key} style={{ borderTop: "1px solid var(--grid)" }}>
                    <td className="py-1.5 whitespace-nowrap" title={dropExplain(f.reason, lang)}>
                      <span aria-hidden className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: TIER_BORDER[f.tier] }} />
                      <span className="font-mono text-xs">{f.reason}</span>
                      {f.proto && <span className="ml-1 text-xs" style={{ color: "var(--text-muted)" }}>{f.proto}</span>}
                    </td>
                    <td className="py-1.5 whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>{f.from || "–"}</td>
                    <td className="py-1.5 whitespace-nowrap">{f.to || "–"}</td>
                    <td className="py-1.5 whitespace-nowrap">{f.listener || "–"}</td>
                    <td className="py-1.5 text-right" style={{ color: f.tier === "trouble" ? "var(--status-warning)" : "var(--text-secondary)" }}>{f.count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("net.listenerNote")}</p>
      </div>
    </section>
  );
}

// Trouble in the warning color, notable in the caution color, housekeeping in the grid color
const TIER_BORDER: Record<DropTier, string> = { trouble: LEVEL_COLOR.warning, notable: LEVEL_COLOR.caution, noise: "var(--border)" };

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
