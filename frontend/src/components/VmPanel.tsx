import { useMemo, useState } from "react";
import type { Incident, Sample } from "../types/model";
import { formatUs, percentile } from "../lib/hist";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_KEY, type Level } from "../lib/lens";
import { signalName } from "../lib/lifecycle";
import { formatMsPerSec } from "../lib/memory";
import { asLevel, durationSeconds } from "../lib/incidents";
import { byCpu, culpritList, culpritsFor, formatMs, impact, pct, procLabel, samplesBetween, type CulpritMember } from "../lib/impact";
import {
  latestVmCpuWait, levelFor, runningVms, vmComm, vmPseudoSamples, vmStallMsPerSec, vmStallSeries, vmState, vmWaitP99, type VmState,
 lifecycleFrom } from "../lib/vms";
import { useTriggers } from "../lib/useTriggers";
import { useSettings } from "../lib/useSettings";
import type { TimeWindow } from "../lib/timeWindow";
import { formatTime, useI18n, type Lang, type TFn } from "../lib/i18n";
import { Heatmap } from "./Heatmap";
import { PercentileChart } from "./PercentileChart";
import { Sparkline } from "./Sparkline";
import { IncidentTable } from "./IncidentTable";
import { ReportButton } from "./ReportButton";
import { formatReport, incidentLine, ownerOf, stamp, stampFull, vmNextStep } from "../lib/report";

const WINDOW = 300; // the whole visible range (5 min)
const LINGER_MS = 5 * 60 * 1000; // a stop this recent is still the headline, even if the VM is running again
const STEAL_ROWS = 5; // rows in "who took this VM's CPU"

type Cause = "host_oom" | "cgroup_oom" | "crash" | "killed" | "shutdown";
const CAUSES = new Set<string>(["host_oom", "cgroup_oom", "crash", "killed", "shutdown"]);

// One page per VM: what the host saw of its QEMU process, and why it stopped (ADR 0001: verdict, evidence, next step)
export function VmPanel({ host, name, vmSamples, samples, memSamples, incidents, win, schemeKey }: {
  host: string; name: string; vmSamples: Sample[]; samples: Sample[]; memSamples: Sample[]; incidents: Incident[]; win: TimeWindow; schemeKey: string;
}) {
  const { lang, t } = useI18n();
  const triggers = useTriggers();
  const nowMs = Date.now();
  const info = runningVms(vmSamples)?.find((v) => v.name === name);
  const vm = vmState(name, info, incidents, nowMs, lifecycleFrom(useSettings().ui.vm));
  const pseudo = useMemo(() => vmPseudoSamples(samples, name), [samples, name]);
  const stallSeries = useMemo(() => vmStallSeries(memSamples, name), [memSamples, name]);
  const stallNow = vmStallMsPerSec(memSamples, name);
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const known = vm.running || vm.incidents.length > 0;

  return (
    <div className="space-y-6">
      <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-lg font-semibold">{name}</h2>
          <span className="text-sm" style={{ color: "var(--text-secondary)" }}><Header vm={vm} /></span>
        </div>
        {!known && <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>{t("vm.notFound")}</p>}

        <div className="mt-4">
          <div className="mb-1 text-xs" style={{ color: "var(--text-muted)" }}>VM Lens Summary</div>
          <VmSummary host={host} vm={vm} samples={samples} memSamples={memSamples} nowMs={nowMs} />
        </div>
      </section>

      <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
        <h2 className="text-lg font-semibold">{t("vm.chartTitle")}</h2>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>Run Queue Latency · runqlat · {`vm:${name}`}</div>
        {/* Side by side on wide screens like the host CPU card; both x axes cover the same 5 minutes and share the cursor */}
        <div className="mt-4 grid gap-8 lg:grid-cols-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("cpu.distTitle")}</h3>
            <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("vm.chartNote")}</p>
            <Heatmap samples={pseudo} win={win} schemeKey={schemeKey} hoverMs={hoverMs} onHover={setHoverMs} />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("cpu.trendTitle")}</h3>
            <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("vm.trendNote")}</p>
            <PercentileChart samples={pseudo} win={win} schemeKey={schemeKey} hoverMs={hoverMs} onHover={setHoverMs} />
          </div>
        </div>

        <div className="mt-6 max-w-md">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("vm.stallTitle")}</h3>
          <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{t("vm.stallNote")}</p>
          <div className="flex items-center gap-3">
            <Marked level={levelFor(stallNow, triggers.memory.caution, triggers.memory.warning)}>
              <span className="text-lg">{formatMsPerSec(stallNow, lang)}</span>
            </Marked>
            <div className="min-w-0 flex-1"><Sparkline values={stallSeries} label={t("use.sparkAria", { note: t("vm.stallTitle") })} /></div>
          </div>
        </div>
      </section>

      <StealPanel name={name} samples={samples} incidents={incidents} nowMs={nowMs} />

      <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
        <h2 className="text-lg font-semibold">{t("vm.incidentsTitle")}</h2>
        {vm.incidents.length === 0 ? (
          <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>{t("common.none")}</p>
        ) : (
          <div className="mt-2"><IncidentTable incidents={vm.incidents} nowMs={nowMs} /></div>
        )}
      </section>
    </div>
  );
}

// "running · pid N · since HH:MM:SS" or "stopped · stopped at HH:MM:SS"
function Header({ vm }: { vm: VmState }) {
  const { lang, t } = useI18n();
  const parts: string[] = [];
  if (vm.running && vm.info) {
    parts.push(t("vm.state.running"), t("vm.header.pid", { pid: vm.info.pid }), t("vm.header.since", { time: formatTime(lang, vm.info.since) }));
  } else {
    parts.push(t("vm.state.stopped"));
    if (vm.lastDown) {
      parts.push(t("vm.header.stoppedAt", { time: formatTime(lang, vm.lastDown.start) }));
      if (vm.lastDown.pid) parts.push(t("vm.header.pid", { pid: vm.lastDown.pid }));
    }
  }
  return <>{parts.join(" · ")}</>;
}

// Same look as the host Lens Summary: level icon + label + headline, then the findings.
// A stop in the last 5 minutes is the headline even if the VM is running again; a running VM that is waiting for host CPU
// right now gets that as its headline with the evidence and next step; otherwise a running VM gets its 5-minute numbers,
// and the latest stop of the last 24 h is kept below as a post-mortem
function VmSummary({ host, vm, samples, memSamples, nowMs }: { host: string; vm: VmState; samples: Sample[]; memSamples: Sample[]; nowMs: number }) {
  const { lang, t } = useI18n();
  const triggers = useTriggers();
  const down = vm.lastDown;
  const recentStop = down != null && nowMs - Date.parse(down.start) <= LINGER_MS;
  const cause = down && CAUSES.has(down.cause ?? "") ? (down.cause as Cause) : undefined;
  const cpuWait = vm.running ? vm.cpuWait : undefined;

  // An old stop is history, not a status: the header then shows a neutral "stopped" mark rather than "OK"
  const stale = down != null && !vm.running && !recentStop;
  let level: Level;
  let headline: string;
  if (down && (recentStop || !vm.running)) {
    level = recentStop ? vm.level : "ok";
    headline = t(cause ? `vm.headline.${cause}` : "vm.headline.unknown");
  } else if (cpuWait) {
    level = asLevel(cpuWait.level);
    headline = t("vm.headline.cpuWait");
  } else if (vm.running) {
    // Levels for a running VM come from the same thresholds the server judges the host with
    const p99 = vmWaitP99(samples, vm.name, WINDOW);
    const stall = vmStallMsPerSec(memSamples, vm.name, WINDOW);
    level = worst(levelFor(p99, triggers.cpu.caution, triggers.cpu.warning), levelFor(stall, triggers.memory.caution, triggers.memory.warning));
    headline = t("vm.headline.running");
  } else {
    level = "ok";
    headline = t("vm.state.stopped");
  }

  // The report ready to send: the same verdict, evidence and next step as below, plus whose problem it probably is
  const report = () => {
    const levelLabel = stale ? t("vm.state.stopped") : t(LEVEL_KEY[level]);
    const situation: string[] = [headline];
    if (vm.running && vm.info) situation.push(runningSentence(vm.name, samples, memSamples, triggers.cpu.caution, triggers.memory.caution, lang, t));
    if (down) situation.push(t("vm.lastStop", { time: stamp(down.start, lang) }));
    const subject = down && (recentStop || !vm.running) ? down : cpuWait;
    const evidence = subject === down && down ? stopEvidence(down, cause, lang, t)
      : cpuWait ? cpuWaitEvidence(cpuWait, vm.name, samples, nowMs, lang, t) : [];
    const next = subject === down && down
      ? vmNextStep(cause, down.triggerComm ? t("vm.who", { comm: down.triggerComm, pid: down.triggerPid ?? "?" }) : undefined, t)
      : cpuWait ? t("vm.next.cpuWait") : "";
    return formatReport(
      `${host} / VM ${vm.name} — ${levelLabel}: ${headline}`,
      t("report.meta", { time: stampFull(Date.now(), lang), url: window.location.href }),
      [
        { title: t("report.situation"), lines: situation },
        { title: t("report.next"), lines: next ? [next] : [t("report.nextNone")] },
        { title: t("report.owner"), lines: [subject ? ownerOf(subject, t) : t("report.ownerNone")] },
        { title: t("report.evidence"), lines: evidence },
        { title: t("report.recent"), lines: vm.incidents.slice(0, 10).map((x) => incidentLine(x, lang, t)) },
      ],
    );
  };

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-2 text-lg font-semibold">
          <span aria-hidden style={{ color: stale ? "var(--text-muted)" : LEVEL_COLOR[level] }}>{stale ? "○" : LEVEL_ICON[level]}</span>
          <span>{stale ? t("vm.state.stopped") : t(LEVEL_KEY[level])}</span>
          <span style={{ color: "var(--text-secondary)" }}>·</span>
          <span>{headline}</span>
        </div>
        <ReportButton build={report} />
      </div>
      <div className="mt-2 space-y-3 text-sm" style={{ color: "var(--text-secondary)" }}>
        {vm.running && vm.info && (
          <p>
            {recentStop && t("vm.runningAgain", { time: formatTime(lang, vm.info.since), pid: vm.info.pid })}
            {recentStop && " "}
            {runningSentence(vm.name, samples, memSamples, triggers.cpu.caution, triggers.memory.caution, lang, t)}
          </p>
        )}
        {cpuWait && !recentStop && <CpuWaitBrief x={cpuWait} name={vm.name} samples={samples} nowMs={nowMs} />}
        {down && <PostMortem x={down} cause={cause} showTime={vm.running && !recentStop} />}
      </div>
    </div>
  );
}

// CPU wait p99 and reclaim stall of the VM over the visible 5 minutes, and whether either second crossed the caution threshold
function runningSentence(name: string, samples: Sample[], memSamples: Sample[], cpuCaution: number, memCaution: number, lang: Lang, t: TFn): string {
  const p99 = vmWaitP99(samples, name, WINDOW);
  const stall = vmStallMsPerSec(memSamples, name, WINDOW);
  if (p99 == null && stall == null) return t("vm.running.noData");
  const cpuCrossed = vmPseudoSamples(samples, name).some((s) => (percentile(s.slots, 0.99) ?? 0) >= cpuCaution);
  const memCrossed = vmStallSeries(memSamples, name).some((v) => (v ?? 0) >= memCaution);
  const crossed = cpuCrossed && memCrossed
    ? t("vm.running.crossedBoth")
    : cpuCrossed
      ? t("vm.running.crossedCpu", { v: formatUs(cpuCaution) })
      : memCrossed
        ? t("vm.running.crossedMem", { v: formatMsPerSec(memCaution, lang) })
        : t("vm.running.crossedNone");
  return t("vm.running.sentence", { p99: formatUs(p99), stall: formatMsPerSec(stall, lang), crossed });
}

// Evidence and next step for one vm_down, built only from the fields the server actually recorded
function stopEvidence(x: Incident, cause: Cause | undefined, lang: Lang, t: TFn): string[] {
  const evidence: string[] = [];
  const sig = x.signal ? signalName(x.signal, lang) : undefined;

  if (cause === "cgroup_oom" || cause === "host_oom") {
    evidence.push(t(x.memcg || cause === "cgroup_oom" ? "vm.ev.oomCgroup" : "vm.ev.oomHost"));
    if (x.triggerComm) evidence.push(t("vm.ev.oomTrigger", { comm: x.triggerComm, pid: x.triggerPid ?? "?" }));
  } else if (sig) {
    evidence.push(x.triggerComm ? t("vm.ev.signalFrom", { sig, comm: x.triggerComm, pid: x.triggerPid ?? "?" }) : t("vm.ev.signal", { sig }));
  }
  // Only say what the server recorded: an absent coreDump field is not evidence either way
  if (cause === "crash" && x.coreDump != null) evidence.push(t(x.coreDump ? "vm.ev.coreDump" : "vm.ev.noCoreDump"));
  if (cause === "shutdown" && x.exitStatus != null) evidence.push(t("vm.ev.exitStatus", { n: x.exitStatus }));
  if (x.contextStallMs != null) evidence.push(t("vm.ev.stall", { ms: x.contextStallMs.toFixed(x.contextStallMs < 10 ? 1 : 0) }));
  if (x.contextWaitP99Us != null) evidence.push(t("vm.ev.wait", { v: formatUs(x.contextWaitP99Us) }));
  return evidence;
}

function PostMortem({ x, cause, showTime }: { x: Incident; cause?: Cause; showTime: boolean }) {
  const { lang, t } = useI18n();
  const who = x.triggerComm ? t("vm.who", { comm: x.triggerComm, pid: x.triggerPid ?? "?" }) : undefined;
  const evidence = stopEvidence(x, cause, lang, t);
  const next = vmNextStep(cause, who, t);

  return (
    <div className="space-y-1.5">
      {showTime && <p className="font-semibold" style={{ color: "var(--text-primary)" }}>{t("vm.lastStop", { time: formatTime(lang, x.start) })}</p>}
      {evidence.length > 0 && (
        <div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>{t("vm.evidence")}</div>
          <ul className="ml-4 list-disc space-y-0.5">
            {evidence.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}
      <div>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>{t("vm.nextStep")}</div>
        <p style={{ color: "var(--text-primary)" }}>{next}</p>
      </div>
    </div>
  );
}

// Evidence and next step while the VM is waiting for host CPU: its own wait, and who took the CPU (the incident's group,
// which the server computed without the VM itself; older data falls back to the samples, again without the VM)
function cpuWaitEvidence(x: Incident, name: string, samples: Sample[], nowMs: number, lang: Lang, t: TFn): string[] {
  const range = samplesBetween(samples, new Date(x.start), x.end ? new Date(x.end) : new Date(nowMs));
  const xs = impact(range).filter((p) => p.comm !== vmComm(name));
  const { members, total, busy } = culpritsFor(x, xs, range);
  return [
    t("vm.ev.cpuWait", { v: formatUs(x.peak ?? null), seconds: durationSeconds(x, nowMs) ?? x.seconds, time: formatTime(lang, x.start) }),
    takenBy(members, total, busy, t),
  ];
}

function CpuWaitBrief({ x, name, samples, nowMs }: { x: Incident; name: string; samples: Sample[]; nowMs: number }) {
  const { lang, t } = useI18n();
  const evidence = cpuWaitEvidence(x, name, samples, nowMs, lang, t);
  return (
    <div className="space-y-1.5">
      <div>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>{t("vm.evidence")}</div>
        <ul className="ml-4 list-disc space-y-0.5">
          {evidence.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      </div>
      <div>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>{t("vm.nextStep")}</div>
        <p style={{ color: "var(--text-primary)" }}>{t("vm.next.cpuWait")}</p>
      </div>
    </div>
  );
}

// "CPU taken by a (34%), b (24%) — 81% together", or the honest alternative when no one stands out
function takenBy(members: CulpritMember[], total: number, busy: number | null, t: TFn): string {
  if (members.length === 0) return busy == null ? t("vm.ev.noCulpritNoBusy") : t("vm.ev.noCulprit", { busy: pct(busy) });
  if (members.length === 1) return t("vm.ev.takenByOne", { list: culpritList(members, t) });
  return t("vm.ev.takenBy", { list: culpritList(members, t), pct: pct(total) });
}

// "Who took this VM's CPU": the host's top CPU consumers, without the VM itself, over the latest vm_cpu_wait of the last 24 h
// (else the visible 5 minutes). Group members are marked. When the episode is older than the samples in view, the server's
// group is still listed, without CPU time
function StealPanel({ name, samples, incidents, nowMs }: { name: string; samples: Sample[]; incidents: Incident[]; nowMs: number }) {
  const { lang, t } = useI18n();
  const ep = latestVmCpuWait(incidents, name);
  const range = ep ? samplesBetween(samples, new Date(ep.start), ep.end ? new Date(ep.end) : new Date(nowMs)) : samples;
  const xs = impact(range).filter((p) => p.comm !== vmComm(name));
  const { members, total, busy } = culpritsFor(ep, xs, range);
  const memberNames = new Set(members.map((m) => m.name));
  // Rows: the samples' top consumers; or, with no samples for the episode, the group the server recorded
  const rows: { name: string; label: string; share: number; onCpuNs: number | null }[] = xs.length > 0
    ? byCpu(xs).slice(0, STEAL_ROWS).map((p) => ({ name: p.comm, label: procLabel(p), share: p.cpuShare, onCpuNs: p.onCpuNs }))
    : members.map((m) => ({ name: m.name, label: m.name, share: m.share, onCpuNs: null }));
  const maxShare = Math.max(...rows.map((r) => r.share), 0.01);
  const scope = ep
    ? t("vm.stealScopeEpisode", {
        range: `${formatTime(lang, ep.start)}${t("range.sep")}${ep.end ? formatTime(lang, ep.end) : t("common.ongoing")}`,
      })
    : t("vm.stealScopeRecent", { n: WINDOW / 60 });

  return (
    <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
      <h2 className="text-lg font-semibold">{t("vm.stealTitle")}</h2>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{t("vm.stealDesc", { scope })}</p>
      {members.length > 0 && (
        <p className="mt-3 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{takenBy(members, total, busy, t)}</p>
      )}
      {rows.length === 0 ? (
        <p className="mt-3 text-sm" style={{ color: "var(--text-muted)" }}>{t("vm.stealNoData")}</p>
      ) : (
        <table className="mt-3 w-full max-w-2xl text-sm tabular">
          <thead style={{ color: "var(--text-muted)" }}>
            <tr>
              <th className="py-1 text-left font-normal">{t("vm.stealCol.who")}</th>
              <th className="py-1 text-left font-normal">{t("impact.cpuShare")}</th>
              <th className="py-1 text-right font-normal">{t("impact.cpuTime")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} style={{ borderTop: "1px solid var(--grid)" }}>
                <td className="py-1.5 pr-2">
                  {r.label}
                  {memberNames.has(r.name) && (
                    <span className="ml-1 text-xs" style={{ color: "var(--text-muted)" }}>{t("impact.culpritTag")}</span>
                  )}
                </td>
                <td className="py-1.5 pr-2">
                  <div className="flex items-center gap-2">
                    <span className="w-10 text-right">{(r.share * 100).toFixed(r.share < 0.1 ? 1 : 0)}%</span>
                    <span className="h-1.5 flex-1 rounded-sm" style={{ background: "var(--grid)" }}>
                      <span className="block h-1.5 rounded-sm" style={{ width: `${(r.share / maxShare) * 100}%`, background: "var(--series-1)" }} />
                    </span>
                  </div>
                </td>
                <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{r.onCpuNs == null ? "–" : formatMs(r.onCpuNs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// Every next step carries its reason (ADR 0001, principle 3); an unknown cause says so instead of guessing

const RANK: Record<Level, number> = { ok: 0, caution: 1, warning: 2 };
const worst = (a: Level, b: Level): Level => (RANK[a] >= RANK[b] ? a : b);

function Marked({ level, children }: { level: Level; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <span className={level === "ok" ? "" : "font-semibold"}>
      {level !== "ok" && (
        <>
          <span aria-hidden style={{ color: LEVEL_COLOR[level] }}>{LEVEL_ICON[level]} </span>
          <span className="sr-only">{t(LEVEL_KEY[level])} </span>
        </>
      )}
      {children}
    </span>
  );
}
