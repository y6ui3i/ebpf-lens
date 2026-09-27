import type { Incident, Sample } from "../types/model";
import { formatUs } from "../lib/hist";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_KEY, type Level } from "../lib/lens";
import { asLevel, kindKey } from "../lib/incidents";
import { formatMsPerSec } from "../lib/memory";
import { knownVms, levelFor, runningVms, vmCpuShare, vmStallMsPerSec, vmWaitP99, type VmState } from "../lib/vms";
import { useTriggers } from "../lib/useTriggers";
import { Link, vmPath } from "../lib/router";
import { formatHM, formatTime, useI18n } from "../lib/i18n";
import { incidentDetail } from "./IncidentTable";

// One row per VM known to the host: running now, or stopped within the last 24 h.
// The numbers are the last 5 s of the VM's QEMU process as seen by the host (runqlat / memstall per-process stats)
export function VmListPanel({ vmSamples, samples, memSamples, incidents }: {
  vmSamples: Sample[]; samples: Sample[]; memSamples: Sample[]; incidents: Incident[];
}) {
  const { lang, t } = useI18n();
  const triggers = useTriggers();
  const nowMs = Date.now();
  const vms = knownVms(vmSamples, incidents, nowMs);
  const noVmData = runningVms(vmSamples) === undefined;

  return (
    <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
      <h2 className="text-lg font-semibold">{t("vml.title")}</h2>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>Virtual machines · vms / runqlat / memstall</div>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{t("vml.desc")}</p>

      {vms.length === 0 ? (
        <p className="mt-4 text-sm" style={{ color: "var(--text-muted)" }}>{t(noVmData ? "summary.vm.unknown" : "vml.empty")}</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[44rem] text-sm tabular">
            <thead style={{ color: "var(--text-muted)" }}>
              <tr>
                <th className="py-1 text-left font-normal">{t("vml.col.vm")}</th>
                <th className="py-1 text-left font-normal">{t("vml.col.state")}</th>
                <th className="py-1 text-right font-normal">{t("vml.col.wait")}</th>
                <th className="py-1 text-right font-normal">{t("vml.col.share")}</th>
                <th className="py-1 text-right font-normal">{t("vml.col.stall")}</th>
                <th className="py-1 pl-4 text-left font-normal">{t("vml.col.last")}</th>
              </tr>
            </thead>
            <tbody>
              {vms.map((v) => {
                const wait = v.running ? vmWaitP99(samples, v.name) : null;
                const share = v.running ? vmCpuShare(samples, v.name) : null;
                const stall = v.running ? vmStallMsPerSec(memSamples, v.name) : null;
                const last = v.incidents[0];
                return (
                  <tr key={v.name} style={{ borderTop: "1px solid var(--grid)" }}>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      <Link to={vmPath(v.name)} className="underline decoration-[var(--border)] underline-offset-2 hover:decoration-current">{v.name}</Link>
                    </td>
                    <td className="py-1.5 pr-3" style={{ color: "var(--text-secondary)" }}>
                      <StateCell vm={v} />
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      <Marked level={levelFor(wait, triggers.cpu.caution, triggers.cpu.warning)}>{formatUs(wait)}</Marked>
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
                      {share == null ? "–" : `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`}
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      <Marked level={levelFor(stall, triggers.memory.caution, triggers.memory.warning)}>{formatMsPerSec(stall, lang)}</Marked>
                    </td>
                    <td className="py-1.5 pl-4" style={{ color: "var(--text-secondary)" }}>
                      {last ? (
                        <>
                          <Marked level={asLevel(last.level)}>{t(kindKey(last.kind))}</Marked>
                          {" · "}{formatTime(lang, last.start)}
                          <span style={{ color: "var(--text-muted)" }}> · {incidentDetail(last, lang, t)}</span>
                        </>
                      ) : (
                        <span style={{ color: "var(--text-muted)" }}>{t("common.none")}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// "Running since HH:MM" or "Stopped at HH:MM · cause", with the state mark used in the menu
function StateCell({ vm }: { vm: VmState }) {
  const { lang, t } = useI18n();
  if (vm.running && vm.info) {
    return (
      <span className="whitespace-nowrap">
        <span aria-hidden className="text-[0.6rem]" style={{ color: "var(--status-good)" }}>● </span>
        {t("vml.runningSince", { time: formatHM(lang, vm.info.since) })}
      </span>
    );
  }
  const d = vm.lastDown;
  return (
    <span>
      <span aria-hidden className="text-[0.6rem]" style={{ color: "var(--text-muted)" }}>○ </span>
      {d ? t("vml.stoppedAt", { time: formatHM(lang, d.start), cause: incidentDetail(d, lang, t) }) : t("vm.state.stopped")}
    </span>
  );
}

// A value with the level icon in front of it when it crossed a threshold (icon + hidden label, not color alone)
function Marked({ level, children }: { level: Level; children: React.ReactNode }) {
  const { t } = useI18n();
  if (level === "ok") return <>{children}</>;
  return (
    <span className="font-semibold">
      <span aria-hidden style={{ color: LEVEL_COLOR[level] }}>{LEVEL_ICON[level]} </span>
      <span className="sr-only">{t(LEVEL_KEY[level])} </span>
      {children}
    </span>
  );
}
