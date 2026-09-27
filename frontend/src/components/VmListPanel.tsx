import { useState } from "react";
import type { Incident, Sample } from "../types/model";
import { formatUs } from "../lib/hist";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_KEY, type Level } from "../lib/lens";
import { asLevel, isInstantKind, isOngoing, kindKey } from "../lib/incidents";
import { formatMsPerSec } from "../lib/memory";
import { knownVms, levelFor, lifecycleFrom, runningVms, vmCpuShare, vmStallMsPerSec, vmWaitP99, type VmState } from "../lib/vms";
import { useSettings } from "../lib/useSettings";
import { useTriggers } from "../lib/useTriggers";
import { Link, vmPath } from "../lib/router";
import { formatHM, formatTime, useI18n } from "../lib/i18n";
import { incidentDetail } from "./IncidentTable";

// One row per VM known to the host: running now, or stopped within the last 24 h.
// The numbers are the last 5 s of the VM's QEMU process as seen by the host (runqlat / memstall per-process stats)
export function VmListPanel({ vmSamples, samples, memSamples, incidents }: {
  vmSamples: Sample[]; samples: Sample[]; memSamples: Sample[]; incidents: Incident[];
}) {
  const { t } = useI18n();
  const nowMs = Date.now();
  const vms = knownVms(vmSamples, incidents, nowMs, lifecycleFrom(useSettings().ui.vm));
  const noVmData = runningVms(vmSamples) === undefined;
  // Running (and VMs that need attention) always shown; the stopped ones fold away, closed by default, so ten VMs
  // taken down together do not bury the ones that matter. With nothing running the fold opens by itself
  const live = vms.filter((v) => v.phase === "running" || v.phase === "attention");
  const stopped = vms.filter((v) => v.phase === "stopped" || v.phase === "past")
    .sort((a, b) => Date.parse(b.lastDown?.start ?? "") - Date.parse(a.lastDown?.start ?? "")); // newest stop first
  const [stoppedOpen, setStoppedOpen] = useState(false);
  const showStopped = stoppedOpen || live.length === 0;

  return (
    <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
      <h2 className="text-lg font-semibold">{t("vml.title")}</h2>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>Virtual machines · vms / runqlat / memstall</div>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{t("vml.desc")}</p>

      {vms.length === 0 ? (
        <p className="mt-4 text-sm" style={{ color: "var(--text-muted)" }}>{t(noVmData ? "summary.vm.unknown" : "vml.empty")}</p>
      ) : (
        <>
          <h3 className="mt-4 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("vml.running", { n: live.length })}</h3>
          {live.length === 0 ? (
            <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>{t("vml.noneRunning")}</p>
          ) : (
            <VmTable vms={live} samples={samples} memSamples={memSamples} />
          )}
          {stopped.length > 0 && (
            <>
              <button
                onClick={() => setStoppedOpen((v) => !v)}
                aria-expanded={showStopped}
                className="mt-5 flex items-center gap-2 text-sm font-semibold"
                style={{ color: "var(--text-secondary)" }}
              >
                <span aria-hidden className={`text-xs transition-transform duration-200 motion-reduce:transition-none ${showStopped ? "" : "-rotate-90"}`} style={{ color: "var(--text-muted)" }}>⌄</span>
                {t("vml.stopped", { n: stopped.length })}
              </button>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>{t("vml.stoppedNote")}</p>
              {showStopped && <VmTable vms={stopped} samples={samples} memSamples={memSamples} />}
            </>
          )}
        </>
      )}
    </section>
  );
}

function VmTable({ vms, samples, memSamples }: { vms: VmState[]; samples: Sample[]; memSamples: Sample[] }) {
  const { lang, t } = useI18n();
  const triggers = useTriggers();
  return (
    <>
      {(
        <div className="mt-2 overflow-x-auto">
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
                // What is happening now (an ongoing vm_cpu_wait) outranks the newest ended incident
                const last = v.incidents.find(isOngoing) ?? v.incidents[0];
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
                          {isOngoing(last) && !isInstantKind(last.kind) && <>{" · "}{t("common.ongoing")}</>}
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
    </>
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
