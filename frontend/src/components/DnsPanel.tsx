import { useState } from "react";
import type { Sample } from "../types/model";
import type { TimeWindow } from "../lib/timeWindow";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_KEY, type Level } from "../lib/lens";
import { useTriggers } from "../lib/useTriggers";
import { useI18n } from "../lib/i18n";
import { formatUs } from "../lib/hist";
import { currentDns, dnsErrorKey, nameRows, resolverRows } from "../lib/dns";
import { Heatmap } from "./Heatmap";
import { LatencyChart } from "./LatencyChart";

// Name resolution as applications experience it (glibc getaddrinfo): how long, which names fail and why, who asks.
// `level` is the DNS area's level from the server's dns_fail / dns_slow incidents
export function DnsPanel({ samples, win, schemeKey, level }: { samples: Sample[]; win: TimeWindow; schemeKey: string; level: Level }) {
  const { t } = useI18n();
  const thresholds = useTriggers().dns;
  const now = currentDns(samples);
  const names = nameRows(samples);
  const resolvers = resolverRows(samples);
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  if (!now.has) {
    return (
      <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
        <h2 className="text-lg font-semibold">{t("dns.title")}</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>{t("dns.none")}</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
      <h2 className="text-lg font-semibold">{t("dns.title")}</h2>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>getaddrinfo · uprobe on glibc · dnslat</div>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{t("dns.desc")}</p>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Tile label={t("dns.tileRate")} value={now.lookupsPerSec == null ? "–" : now.lookupsPerSec.toFixed(1)} note={t("dns.tileRateNote")} />
        <Tile label={t("dns.tileP99")} value={formatUs(now.p99)} note={t("dns.tileP99Note")} level={level} />
        <Tile label={t("dns.tileFails")} value={`${now.fails}`} note={t("dns.tileFailsNote")} level={now.fails > 0 ? "caution" : undefined} />
        <Tile label={t("dns.tileNames")} value={`${names.length}`} note={t("dns.tileNamesNote")} />
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("dns.distTitle")}</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("dns.distNote")}</p>
          <Heatmap samples={samples} win={win} schemeKey={schemeKey} hoverMs={hoverMs} onHover={setHoverMs}
            ariaLabel={t("dns.heatAria")} yCaption={t("dns.heatYCaption")} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("dns.trendTitle")}</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>
            {t("dns.trendNote", { c: formatUs(thresholds.latency.caution), w: formatUs(thresholds.latency.warning) })}
          </p>
          <LatencyChart samples={samples} win={win} schemeKey={schemeKey} caution={thresholds.latency.caution} warning={thresholds.latency.warning} ariaLabel={t("dns.chartAria")} />
        </div>
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("dns.namesTitle")}</h3>
          {names.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>{t("common.none")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[30rem] text-sm tabular">
                <thead style={{ color: "var(--text-muted)" }}>
                  <tr>
                    <th className="py-1 text-left font-normal">{t("dns.colName")}</th>
                    <th className="py-1 text-right font-normal">{t("dns.colLookups")}</th>
                    <th className="py-1 text-right font-normal">{t("dns.colFails")}</th>
                    <th className="py-1 text-right font-normal">{t("dns.colAvg")}</th>
                    <th className="py-1 text-right font-normal">{t("dns.colMax")}</th>
                  </tr>
                </thead>
                <tbody>
                  {names.slice(0, 12).map((n) => (
                    <tr key={n.name} style={{ borderTop: "1px solid var(--grid)" }}>
                      <td className="py-1.5 break-all">
                        {n.name}
                        {n.lastError && <span className="ml-1 text-xs" style={{ color: "var(--status-warning)" }}>{t(dnsErrorKey(n.lastError))}</span>}
                      </td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{n.lookups.toLocaleString()}</td>
                      <td className="py-1.5 text-right" style={{ color: n.fails ? "var(--status-warning)" : "var(--text-secondary)" }}>{n.fails}</td>
                      <td className="py-1.5 text-right">{formatUs(n.avgNs / 1000)}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatUs(n.maxNs / 1000)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="min-w-0">
          <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("dns.procsTitle")}</h3>
          {resolvers.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>{t("common.none")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[24rem] text-sm tabular">
                <thead style={{ color: "var(--text-muted)" }}>
                  <tr>
                    <th className="py-1 text-left font-normal">{t("common.process")}</th>
                    <th className="py-1 text-right font-normal">{t("dns.colLookups")}</th>
                    <th className="py-1 text-right font-normal">{t("dns.colFails")}</th>
                    <th className="py-1 text-right font-normal">p99</th>
                    <th className="py-1 text-right font-normal">{t("dns.colMax")}</th>
                  </tr>
                </thead>
                <tbody>
                  {resolvers.slice(0, 10).map((p) => (
                    <tr key={p.comm} style={{ borderTop: "1px solid var(--grid)" }}>
                      <td className="py-1.5">{p.procs > 1 ? `${p.comm} ×${p.procs}` : p.comm}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{p.lookups.toLocaleString()}</td>
                      <td className="py-1.5 text-right" style={{ color: p.fails ? "var(--status-warning)" : "var(--text-secondary)" }}>{p.fails}</td>
                      <td className="py-1.5 text-right">{formatUs(p.p99)}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatUs(p.maxNs / 1000)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("dns.procsNote")}</p>
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
