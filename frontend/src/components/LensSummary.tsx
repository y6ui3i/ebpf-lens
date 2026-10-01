import type { Incident, Sample } from "../types/model";
import { formatUs } from "../lib/hist";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_KEY, baseline, current, type Level } from "../lib/lens";
import { areaLevel, asLevel, isOngoing, latestOf } from "../lib/incidents";
import { byWait, culpritList, culpritsFor, formatMs, impact, pct, samplesBetween } from "../lib/impact";
import { lifecycleSentence, type Lifecycle } from "../lib/lifecycle";
import { memorySentence } from "../lib/memory";
import { GPU_KINDS, gpuSentence } from "../lib/gpu";
import { DISK_KINDS, diskSentence } from "../lib/disk";
import { NET_KINDS, netSentence } from "../lib/net";
import { DNS_KINDS, dnsSentence } from "../lib/dns";
import { FILE_KINDS, filesSentence } from "../lib/files";
import { LOCK_KINDS, locksSentence } from "../lib/locks";
import { IRQ_KINDS, irqSentence } from "../lib/irq";
import { FAULT_KINDS, faultsSentence } from "../lib/faults";
import { VM_AREA_KINDS, runningVms, vmStopsWithin, vmsWaitingForCpu } from "../lib/vms";
import { useTriggers } from "../lib/useTriggers";
import { formatHM, formatTime, translate, useI18n, type Key, type Lang, type Params, type TFn } from "../lib/i18n";
import { hostReport } from "../lib/report";
import { ReportButton } from "./ReportButton";
import { IncidentTable, incidentDetail } from "./IncidentTable";

const CPU_HEADLINE: Record<Level, Key> = {
  ok: "summary.cpu.ok",
  caution: "summary.cpu.caution",
  warning: "summary.cpu.warning",
};

const RANK: Record<Level, number> = { ok: 0, caution: 1, warning: 2 };

const MEM_HEADLINE: Record<Level, Key> = {
  ok: "summary.mem.ok",
  caution: "summary.mem.caution",
  warning: "summary.mem.warning",
};

const PROCESS_KINDS = ["oom_kill", "crash", "crash_loop"] as const;
const MAX_ROWS = 10;
const VM_LINGER_MS = 5 * 60 * 1000; // a VM stop keeps the finding at its level this long (same as isActive for instant kinds)

// Headline for the process area, from whichever process incident is currently active (OOM kill > crash loop > crash)
function lifecycleHeadline(incidents: Incident[], now: number): Key {
  if (areaLevel(incidents, ["oom_kill"], now) !== "ok") return "summary.life.oom";
  if (areaLevel(incidents, ["crash_loop"], now) !== "ok") return "summary.life.loop";
  return "summary.life.crash";
}

// CPU utilization (from the total CPU time of all processes measured with eBPF)
function cpuUtil(samples: Sample[]): number | null {
  const xs = samples.slice(-5).filter((s) => s.cpus > 0 && s.intervalMs > 0);
  if (xs.length === 0) return null;
  const busy = xs.reduce((a, s) => a + s.busyNs, 0);
  const cap = xs.reduce((a, s) => a + s.intervalMs * 1e6 * s.cpus, 0);
  return Math.min(1, busy / cap);
}

// "What is happening right now" summary shown at the top of the screen.
// Levels come from the server's incidents; the numbers in the sentences still come from the samples
export function LensSummary({ host, samples, memSamples, vmSamples, gpuSamples, diskSamples, netSamples, dnsSamples, fileSamples, lockSamples, faultSamples, irqSamples, life, incidents }: {
  host: string; samples: Sample[]; memSamples: Sample[]; vmSamples: Sample[]; gpuSamples: Sample[]; diskSamples: Sample[]; netSamples: Sample[]; dnsSamples: Sample[]; fileSamples: Sample[]; lockSamples: Sample[]; faultSamples: Sample[]; irqSamples: Sample[]; life: Lifecycle; incidents: Incident[];
}) {
  const { lang, t } = useI18n();
  const triggers = useTriggers();
  const nowMs = Date.now();
  const now = current(samples);
  const util = cpuUtil(samples);
  const cpuLevel = areaLevel(incidents, ["cpu_wait"], nowMs);
  const faultLevel = areaLevel(incidents, FAULT_KINDS, nowMs);
  const memLevel = areaLevel(incidents, ["mem_stall", ...FAULT_KINDS], nowMs);
  const procLevel = areaLevel(incidents, PROCESS_KINDS, nowMs);
  const vmLevel = areaLevel(incidents, VM_AREA_KINDS, nowMs);
  const gpuLevel = areaLevel(incidents, GPU_KINDS, nowMs);
  const diskLevel = areaLevel(incidents, DISK_KINDS, nowMs);
  const netLevel = areaLevel(incidents, NET_KINDS, nowMs);
  const dnsLevel = areaLevel(incidents, DNS_KINDS, nowMs);
  const dnsHeadline: Key = areaLevel(incidents, ["dns_fail"], nowMs) !== "ok" ? "summary.dns.fail" : "summary.dns.slow";
  const fileLevel = areaLevel(incidents, FILE_KINDS, nowMs);
  const fileHeadline: Key = areaLevel(incidents, ["file_fail"], nowMs) !== "ok" ? "summary.files.fail" : "summary.files.fsync";
  const lockLevel = areaLevel(incidents, LOCK_KINDS, nowMs);
  const irqLevel = areaLevel(incidents, IRQ_KINDS, nowMs);
  const netHeadline: Key = areaLevel(incidents, ["net_connect_fail"], nowMs) !== "ok" ? "summary.net.fail"
    : areaLevel(incidents, ["net_drop"], nowMs) !== "ok" ? "summary.net.drop"
    : areaLevel(incidents, ["net_retrans"], nowMs) !== "ok" ? "summary.net.retrans" : "summary.net.slow";
  const diskHeadline: Key = areaLevel(incidents, ["disk_error"], nowMs) !== "ok" ? "summary.disk.error" : "summary.disk.slow";
  const gpuHeadline: Key = areaLevel(incidents, ["vram_full"], nowMs) !== "ok" && areaLevel(incidents, ["gpu_starved"], nowMs) === "ok"
    ? "summary.gpu.vram"
    : "summary.gpu.starved";
  // The VM headline names whichever VM problem carries the area's level: a VM waiting for host CPU, or a stop
  const vmCpuWaitLevel = areaLevel(incidents, ["vm_cpu_wait"], nowMs);
  const vmHeadline: Key = vmCpuWaitLevel !== "ok" && RANK[vmCpuWaitLevel] >= RANK[areaLevel(incidents, ["vm_down"], nowMs)]
    ? "summary.vmCpuWait"
    : "summary.vmDown";
  const agentDown = incidents.find((x) => x.kind === "agent_down" && isOngoing(x));
  // The overall status follows the worst area, and the headline uses that area's wording (ties: VM -> CPU -> memory -> processes -> GPU).
  // A host that stopped reporting outranks everything, because no other data is fresh
  const areas: { level: Level; headline: Key }[] = [
    { level: vmLevel, headline: vmHeadline },
    { level: cpuLevel, headline: CPU_HEADLINE[cpuLevel] },
    { level: memLevel, headline: faultLevel !== "ok" && areaLevel(incidents, ["mem_stall"], nowMs) === "ok" ? "summary.faults" : MEM_HEADLINE[memLevel] },
    { level: procLevel, headline: lifecycleHeadline(incidents, nowMs) },
    { level: diskLevel, headline: diskHeadline },
    { level: netLevel, headline: netHeadline },
    { level: dnsLevel, headline: dnsHeadline },
    { level: fileLevel, headline: fileHeadline },
    { level: lockLevel, headline: "summary.locks" },
    { level: irqLevel, headline: "summary.irq" },
    { level: gpuLevel, headline: gpuHeadline },
  ];
  const worstArea = areas.reduce((a, b) => (RANK[b.level] > RANK[a.level] ? b : a));
  const overall: Level = agentDown ? asLevel(agentDown.level) : worstArea.level;
  // When nothing is wrong, the headline is the CPU's "all quiet" sentence (the VM area only has wording for a stop)
  const headline = t(agentDown ? "summary.agentDown" : overall === "ok" ? CPU_HEADLINE.ok : worstArea.headline);
  const base = baseline(samples, triggers.cpu.caution);
  const last = latestOf(incidents, "cpu_wait");
  const recent = incidents.slice(0, MAX_ROWS);

  let detail = "";
  if (now.p99 != null) {
    detail = t(cpuLevel === "ok" ? "summary.p99Ok" : "summary.p99Bad", { p99: formatUs(now.p99) });
    if (base != null) {
      const ratio = now.p99 / base;
      detail += ratio >= 3
        ? t("summary.baseRatio", { base: formatUs(base), ratio: Math.round(ratio) })
        : t("summary.base", { base: formatUs(base) });
    } else {
      detail += t("summary.period");
    }
    if (util != null) detail += t("summary.util", { pct: Math.round(util * 100) });
  }

  // The findings, as text: rendered below and reused as the evidence of the report ready to send
  const findings: { area: string; level: Level; lines: string[] }[] = [
    { area: t("resource.cpu"), level: cpuLevel, lines: [detail, last ? episodeSentence(last, lang) : "", last ? causeText(samples, last, t) ?? "" : ""] },
    { area: t("resource.memory"), level: memLevel, lines: [memorySentence(memSamples, lang, areaLevel(incidents, ["mem_stall"], nowMs)), faultsSentence(faultSamples, lang, faultLevel)] },
    { area: t("resource.processes"), level: procLevel, lines: [lifecycleSentence(life, lang)] },
    { area: t("resource.vm"), level: vmLevel, lines: [vmSentence(vmSamples, incidents, lang, nowMs)] },
    // Hosts without these probes send no samples; their rows stay away rather than saying "no data" forever
    ...(diskSamples.length > 0 ? [{ area: t("resource.disk"), level: diskLevel, lines: [diskSentence(diskSamples, lang, diskLevel)] }] : []),
    ...(netSamples.length > 0 ? [{ area: t("resource.network"), level: netLevel, lines: [netSentence(netSamples, lang, netLevel)] }] : []),
    ...(dnsSamples.length > 0 ? [{ area: t("resource.dns"), level: dnsLevel, lines: [dnsSentence(dnsSamples, lang, dnsLevel)] }] : []),
    ...(fileSamples.length > 0 ? [{ area: t("resource.files"), level: fileLevel, lines: [filesSentence(fileSamples, lang, fileLevel)] }] : []),
    ...(lockSamples.length > 0 ? [{ area: t("resource.locks"), level: lockLevel, lines: [locksSentence(lockSamples, lang, lockLevel)] }] : []),
    ...(irqSamples.length > 0 ? [{ area: t("resource.irq"), level: irqLevel, lines: [irqSentence(irqSamples, lang, irqLevel)] }] : []),
    ...(gpuSamples.length > 0 ? [{ area: t("resource.gpu"), level: gpuLevel, lines: [gpuSentence(gpuSamples, lang, gpuLevel, triggers.gpu.idleUtil)] }] : []),
  ];
  const report = () => hostReport({
    host, levelLabel: t(LEVEL_KEY[overall]), headline, findings, incidents, nowMs: Date.now(), lang, t,
    url: `${window.location.origin}/`,
  });

  return (
    <section
      className="mb-6 rounded-xl p-5"
      style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
      aria-live="polite"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-1 text-xs" style={{ color: "var(--text-muted)" }}>Lens Summary</div>
          <div className="flex flex-wrap items-center gap-x-2 text-lg font-semibold">
            <span aria-hidden style={{ color: LEVEL_COLOR[overall] }}>{LEVEL_ICON[overall]}</span>
            <span>{t(LEVEL_KEY[overall])}</span>
            <span style={{ color: "var(--text-secondary)" }}>·</span>
            <span>{headline}</span>
          </div>
        </div>
        <ReportButton build={report} />
      </div>

      <dl className="mt-3 space-y-2 text-sm">
        {findings.map((f) => (
          <Finding key={f.area} area={f.area} level={f.level}>
            {f.lines.filter(Boolean).map((l, i) => <p key={i}>{l}</p>)}
          </Finding>
        ))}
      </dl>

      {recent.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1 text-xs" style={{ color: "var(--text-muted)" }}>{t("summary.recentIncidents")}</h3>
          <IncidentTable incidents={recent} nowMs={nowMs} />
        </div>
      )}
    </section>
  );
}

// The VM finding: VMs waiting for host CPU right now come first (that is happening now), then the stop sentence:
// a stop in the last 5 minutes wins; otherwise how many run and when the last stop was.
// With no "vms" sample at all we cannot tell whether there are VMs, so say so instead of "none"
function vmSentence(vmSamples: Sample[], incidents: Incident[], lang: Lang, nowMs: number): string {
  const tr = (k: Key, p?: Params) => translate(lang, k, p);
  const waiting = vmsWaitingForCpu(incidents);
  if (waiting.length === 0) return vmStopSentence(vmSamples, incidents, lang, nowMs);
  const first = tr("summary.vm.cpuWait", {
    n: waiting.length,
    names: waiting.map((x) => x.vm ?? x.subject ?? "").join(tr("list.sep")),
    v: formatUs(waiting[0].peak ?? null),
  });
  return `${first} ${vmStopSentence(vmSamples, incidents, lang, nowMs)}`;
}

function vmStopSentence(vmSamples: Sample[], incidents: Incident[], lang: Lang, nowMs: number): string {
  const tr = (k: Key, p?: Params) => translate(lang, k, p);
  const running = runningVms(vmSamples);
  const stops = vmStopsWithin(incidents, nowMs);
  const last = stops[0];
  const describe = (x: Incident) => ({
    name: x.vm ?? x.subject ?? "", time: formatTime(lang, x.start), detail: incidentDetail(x, lang, tr),
  });
  if (last && nowMs - Date.parse(last.start) <= VM_LINGER_MS) return tr("summary.vm.down", describe(last));
  if (running === undefined) return last ? tr("summary.vm.noneRunningLast", describe(last)) : tr("summary.vm.unknown");
  if (running.length === 0) return last ? tr("summary.vm.noneRunningLast", describe(last)) : tr("summary.vm.none");
  return last
    ? tr("summary.vm.runningLast", { n: running.length, ...describe(last) })
    : tr("summary.vm.running", { n: running.length });
}

// Finding for one area. The status is shown with an icon and a label, not by color alone
function Finding({ area, level, children }: { area: string; level: Level; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="grid gap-0.5 sm:grid-cols-[5.5rem_1fr] sm:gap-2">
      <dt className="flex items-start gap-1.5 font-semibold">
        <span aria-hidden style={{ color: LEVEL_COLOR[level] }}>{LEVEL_ICON[level]}</span>
        <span>{area}</span>
        <span className="sr-only">{t(LEVEL_KEY[level])}</span>
      </dt>
      <dd className="space-y-0.5" style={{ color: "var(--text-secondary)" }}>{children}</dd>
    </div>
  );
}

// One sentence on "who used the CPU and who else was kept waiting" during the incident.
// The group comes from the incident when the server recorded one (see culpritsFor); the victims always come from the samples
function causeText(samples: Sample[], episode: Incident, t: TFn): string | null {
  const ongoing = isOngoing(episode);
  const end = ongoing ? new Date() : new Date(episode.end!);
  const range = samplesBetween(samples, new Date(episode.start), end);
  const xs = impact(range);
  const { members, total, busy, fromServer } = culpritsFor(episode, xs, range);
  const names = new Set(members.map((m) => m.name));
  const victims = byWait(xs).filter((x) => !names.has(x.comm)).slice(0, 2);
  // Nothing to say when neither the server nor the samples in view tell us anything about this window
  if (!fromServer && xs.length === 0) return null;
  const parts: string[] = [];
  if (members.length === 1) {
    const m = members[0];
    const who = (m.procs ?? 1) > 1 ? t("cause.who", { comm: m.name, n: m.procs! }) : m.name;
    parts.push(t(ongoing ? "cause.culpritOngoing" : "cause.culpritPast", { who, pct: pct(m.share) }));
  } else if (members.length > 1) {
    parts.push(t(ongoing ? "cause.groupOngoing" : "cause.groupPast", { list: culpritList(members, t, { and: true }), pct: pct(total) }));
  } else {
    parts.push(busy == null ? t("cause.noCulpritNoBusy") : t("cause.noCulprit", { busy: pct(busy) }));
  }
  if (victims.length > 0) {
    const list = victims
      .map((x) => t("cause.victim", { comm: x.comm, total: formatMs(x.waitNs), p99: formatUs(x.p99) }))
      .join(t("list.sep"));
    parts.push(t(members.length > 0 ? "cause.victimsOthers" : "cause.victims", { list }));
  }
  return parts.join(" ");
}

function episodeSentence(e: Incident, lang: Lang): string {
  const tr = (k: Key, p?: Params) => translate(lang, k, p);
  const hm = (d: string) => formatHM(lang, d);
  const peak = formatUs(e.peak ?? null);
  if (isOngoing(e)) {
    return tr("episode.ongoing", { start: hm(e.start), seconds: e.seconds, peak });
  }
  const span = hm(e.start) === hm(e.end!)
    ? tr("episode.spanAround", { t: hm(e.start) })
    : tr("episode.spanRange", { a: hm(e.start), b: hm(e.end!) });
  return tr("episode.past", { span, peak, seconds: e.seconds });
}
