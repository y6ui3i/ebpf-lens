import { useState } from "react";
import type { Incident, Sample } from "../types/model";
import { formatUs } from "../lib/hist";
import { isOngoing, latestOf } from "../lib/incidents";
import { byCpu, byWait, culpritList, culpritsFor, formatMs, impact, pct, procLabel, samplesBetween } from "../lib/impact";
import { formatTime, useI18n } from "../lib/i18n";

const RECENT_SECONDS = 10;
const ROWS = 5;

type Scope = "episode" | "recent";

// Cause (who was using the CPU) and impact (who was kept waiting)
export function ImpactPanel({ samples, incidents }: { samples: Sample[]; incidents: Incident[] }) {
  const { lang, t } = useI18n();
  // The latest CPU contention incident judged by the server. Only offered while it overlaps the samples in view,
  // because per-process data exists only for those samples
  const latest = latestOf(incidents, "cpu_wait");
  const firstMs = samples[0] ? Date.parse(samples[0].time) : Infinity;
  const ep = latest && (isOngoing(latest) || Date.parse(latest.end!) >= firstMs) ? latest : undefined;
  const [picked, setPicked] = useState<Scope>();
  const scope: Scope = picked ?? (ep ? "episode" : "recent");

  const range =
    scope === "episode" && ep
      ? samplesBetween(samples, new Date(ep.start), ep.end ? new Date(ep.end) : new Date())
      : samples.slice(-RECENT_SECONDS);
  const xs = impact(range);
  // Over the episode, the server's group is preferred (it saw the whole window); over the last seconds the same rule
  // runs on the samples
  const { members, total } = culpritsFor(scope === "episode" ? ep : undefined, xs, range);
  const memberNames = new Set(members.map((m) => m.name));
  const cpu = byCpu(xs).slice(0, ROWS);
  const wait = byWait(xs).slice(0, ROWS);
  const maxShare = Math.max(...cpu.map((x) => x.cpuShare), 0.01);

  const scopeLabel =
    scope === "episode" && ep
      ? t("impact.scopeEpisode", {
          range: `${formatTime(lang, ep.start)}${t("range.sep")}${ep.end ? formatTime(lang, ep.end) : t("common.ongoing")}`,
        })
      : t("impact.scopeRecent", { n: RECENT_SECONDS });

  return (
    <section
      className="rounded-xl p-5"
      style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("page.impact")}</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            {t("impact.desc", { scope: scopeLabel })}
          </p>
        </div>
        {ep && (
          <div className="flex gap-1 text-xs" role="group" aria-label={t("impact.scopeAria")}>
            {(["episode", "recent"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setPicked(s)}
                className="rounded-md px-2 py-1"
                aria-pressed={scope === s}
                style={{
                  border: "1px solid var(--border)",
                  background: scope === s ? "var(--page)" : "transparent",
                  color: scope === s ? "var(--text-primary)" : "var(--text-secondary)",
                  fontWeight: scope === s ? 600 : 400,
                }}
              >
                {s === "episode" ? t("impact.btnEpisode") : t("impact.btnRecent", { n: RECENT_SECONDS })}
              </button>
            ))}
          </div>
        )}
      </div>

      {members.length > 0 && (
        <p className="mb-4 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          {members.length === 1
            ? t("impact.groupOne", { list: culpritList(members, t) })
            : t("impact.group", { list: culpritList(members, t), pct: pct(total) })}
        </p>
      )}

      {xs.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          {t("impact.noData")}
        </p>
      ) : (
        <div className="grid gap-8 md:grid-cols-2">
          <div>
            <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>
              {t("impact.cpuTitle")}
            </h3>
            <table className="w-full text-sm tabular">
              <thead style={{ color: "var(--text-muted)" }}>
                <tr>
                  <th className="py-1 text-left font-normal">{t("common.process")}</th>
                  <th className="py-1 text-left font-normal">{t("impact.cpuShare")}</th>
                  <th className="py-1 text-right font-normal">{t("impact.cpuTime")}</th>
                </tr>
              </thead>
              <tbody>
                {cpu.map((x) => (
                  <tr key={x.comm} style={{ borderTop: "1px solid var(--grid)" }}>
                    <td className="py-1.5 pr-2">{procLabel(x)}</td>
                    <td className="py-1.5 pr-2">
                      <div className="flex items-center gap-2">
                        <span className="w-10 text-right">{(x.cpuShare * 100).toFixed(x.cpuShare < 0.1 ? 1 : 0)}%</span>
                        <span className="h-1.5 flex-1 rounded-sm" style={{ background: "var(--grid)" }}>
                          <span
                            className="block h-1.5 rounded-sm"
                            style={{ width: `${(x.cpuShare / maxShare) * 100}%`, background: "var(--series-1)" }}
                          />
                        </span>
                      </div>
                    </td>
                    <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatMs(x.onCpuNs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>
              {t("impact.waitTitle")}
            </h3>
            <table className="w-full text-sm tabular">
              <thead style={{ color: "var(--text-muted)" }}>
                <tr>
                  <th className="py-1 text-left font-normal">{t("common.process")}</th>
                  <th className="py-1 text-right font-normal">{t("impact.waitTotal")}</th>
                  <th className="py-1 text-right font-normal">{t("common.count")}</th>
                  <th className="py-1 text-right font-normal">{t("impact.p99Within")}</th>
                  <th className="py-1 text-right font-normal">{t("impact.max")}</th>
                </tr>
              </thead>
              <tbody>
                {wait.map((x) => (
                  <tr key={x.comm} style={{ borderTop: "1px solid var(--grid)" }}>
                    <td className="py-1.5 pr-2">
                      {procLabel(x)}
                      {memberNames.has(x.comm) && (
                        <span className="ml-1 text-xs" style={{ color: "var(--text-muted)" }}>{t("impact.culpritTag")}</span>
                      )}
                    </td>
                    <td className="py-1.5 text-right">{formatMs(x.waitNs)}</td>
                    <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{x.waitCount.toLocaleString()}</td>
                    <td className="py-1.5 text-right">{formatUs(x.p99)}</td>
                    <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatMs(x.waitMaxNs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="mt-4 text-xs" style={{ color: "var(--text-muted)" }}>
        {t("impact.footer")}
      </p>
    </section>
  );
}
