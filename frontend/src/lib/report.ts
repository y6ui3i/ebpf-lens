// The message ready to send (ADR 0001): situation and next step, whose problem it probably is, the evidence, and the
// recent incidents — as plain text that pastes cleanly into chat, a ticket or an email. Every line is built by rules
// from what the server recorded; when a rule cannot tell, the text says so instead of guessing.
import type { Incident } from "../types/model";
import { asLevel, isActive, isInstantKind, kindKey } from "./incidents";
import type { Level } from "./lens";
import { culpritList } from "./impact";
import { type Key, type Lang, type TFn } from "./i18n";
import { incidentDetail } from "../components/IncidentTable";

export type ReportSection = { title: string; lines: string[] };

const RANK: Record<Level, number> = { ok: 0, caution: 1, warning: 2 };

// "【eBPFLens】<title>", a meta line (time, link), then "■ section" blocks with "- " bullets for multi-line sections
export function formatReport(title: string, meta: string, sections: ReportSection[]): string {
  const out = [`【eBPFLens】${title}`, meta, ""];
  for (const s of sections) {
    if (s.lines.length === 0) continue;
    out.push(`■ ${s.title}`);
    if (s.lines.length === 1) out.push(s.lines[0]);
    else for (const l of s.lines) out.push(`- ${l}`);
    out.push("");
  }
  return out.join("\n").trimEnd() + "\n";
}

// A time for a message someone else reads later: the date is added unless it is today (the screen can omit it, a
// message pasted into a ticket cannot — "18:55" from yesterday reads as this evening)
export function stamp(iso: string, lang: Lang, nowMs = Date.now()): string {
  const d = new Date(iso);
  const today = new Date(nowMs).toDateString() === d.toDateString();
  const loc = lang === "ja" ? "ja-JP" : "en-GB";
  const time = d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return today ? time : `${d.toLocaleDateString(loc, { month: "numeric", day: "numeric" })} ${time}`;
}

function span(x: Incident, lang: Lang, t: TFn, nowMs: number): string {
  if (isInstantKind(x.kind)) return stamp(x.start, lang, nowMs);
  return `${stamp(x.start, lang, nowMs)}${t("range.sep")}${x.end ? stamp(x.end, lang, nowMs) : t("common.ongoing")}`;
}

// One incident as a line: "10:14:02–ongoing · Caution · Slow disk I/O (sda) · 477 ms · issued mostly by dd (95%)"
export function incidentLine(x: Incident, lang: Lang, t: TFn, nowMs = Date.now()): string {
  const who = x.vm ?? x.subject;
  const kind = t(kindKey(x.kind)) + (who ? ` (${who})` : "");
  const detail = incidentDetail(x, lang, t).replace(/^ · /, "");
  return [span(x, lang, t, nowMs), t(`level.${asLevel(x.level)}` as Key), kind, detail].filter(Boolean).join(" · ");
}

// Incidents that still count, worst first, newest first within a level
export function activeIncidents(incidents: Incident[], nowMs: number): Incident[] {
  return incidents
    .filter((x) => isActive(x, nowMs))
    .sort((a, b) => RANK[asLevel(b.level)] - RANK[asLevel(a.level)] || Date.parse(b.start) - Date.parse(a.start));
}

const names = (x: Incident, t: TFn) => (x.culprits?.length ? culpritList(x.culprits, t, { max: 3 }) : "");

// Whose problem it probably is — the first question of triage (ADR 0001). Fixed rules over the incident's own fields
export function ownerOf(x: Incident, t: TFn): string {
  switch (x.kind) {
    case "cpu_wait":
    case "vm_cpu_wait":
      return x.culprits?.length ? t("owner.cpuCulprits", { list: names(x, t) }) : t("owner.hostCpu");
    case "mem_stall":
      return t("owner.hostMemory");
    case "oom_kill":
      return x.memcg ? t("owner.cgroupLimit", { comm: x.subject ?? "?" }) : t("owner.hostOom", { trigger: x.triggerComm ?? "?" });
    case "crash":
    case "crash_loop":
      return t("owner.app", { comm: x.subject ?? "?" });
    case "agent_down":
      return t("owner.hostDown");
    case "vm_down":
      switch (x.cause) {
        case "host_oom": return t("owner.hostOom", { trigger: x.triggerComm ?? "?" });
        case "cgroup_oom": return t("owner.vmLimit");
        case "crash": return t("owner.hypervisor");
        case "killed": return x.triggerComm ? t("owner.human", { comm: x.triggerComm }) : t("owner.unknown");
        case "shutdown": return t("owner.guest");
        default: return t("owner.unknown");
      }
    case "disk_slow":
      return x.culprits?.length ? t("owner.ioCulprits", { list: names(x, t) }) : t("owner.device");
    case "disk_error":
      return t("owner.hardware", { device: x.device ?? x.subject ?? "?" });
    case "net_connect_fail":
      return x.culprits?.length ? t("owner.dest", { list: names(x, t) }) : t("owner.destUnknown");
    case "net_connect_slow":
      return (x.peak ?? 0) >= 1_000_000 ? t("owner.network") : x.culprits?.length ? t("owner.dest", { list: names(x, t) }) : t("owner.destUnknown");
    case "net_retrans":
      return t("owner.network");
    case "net_drop":
      return x.culprits?.length ? t("owner.dropCulprits", { list: names(x, t) }) : t("owner.dropUnknown");
    case "dns_fail":
      return x.culprits?.length ? t("owner.dnsNames", { list: names(x, t) }) : t("owner.dnsResolver");
    case "dns_slow":
      return t("owner.dnsResolver");
    case "file_fail":
      return x.culprits?.length ? t("owner.fileCulprits", { list: names(x, t) }) : t("owner.fileUnknown");
    case "fsync_slow":
      return x.culprits?.length ? t("owner.fsyncFiles", { list: names(x, t) }) : t("owner.fsyncDisk");
    case "fault_stall":
      if (!x.culprits?.length) return t("owner.faultsHost");
      return (x.swapShare ?? 0) > 0.5 ? t("owner.faultsSwap", { list: names(x, t) }) : t("owner.faultsCache", { list: names(x, t) });
    case "irq_busy":
      return t("owner.irq", { list: x.culprits?.length ? names(x, t) : "?", cpu: x.subject ?? "?" });
    case "lock_wait": {
      const kernel = x.culprits?.find((c) => c.name === "kernel lock");
      return kernel && kernel.share > 0.5 ? t("owner.lockKernel", { comm: x.subject ?? "?" }) : t("owner.lockApp", { comm: x.subject ?? "?" });
    }
    case "gpu_starved":
      return t("owner.app", { comm: x.subject ?? "?" });
    case "vram_full":
      return t("owner.gpuApp");
    default:
      return t("owner.unknown");
  }
}

// What to do now, with the reason (ADR 0001 principle 3). vm_down uses the VM page's rules
export function nextOf(x: Incident, t: TFn): string {
  if (x.kind === "vm_down") return vmNextStep(x.cause, x.triggerComm ? t("vm.who", { comm: x.triggerComm, pid: x.triggerPid ?? "?" }) : undefined, t);
  if (x.kind === "vm_cpu_wait") return t("vm.next.cpuWait");
  if (x.kind === "net_connect_slow" && (x.peak ?? 0) >= 1_000_000) return t("next.net_connect_slow_loss");
  if (x.kind === "oom_kill") return t(x.memcg ? "next.oom_kill_memcg" : "next.oom_kill_host");
  if (x.kind === "net_drop" && x.culprits?.length) {
    // The culprit is "REASON dst:port (listener)": the reason has its own advice when we know one
    const reason = x.culprits[0].name.split(" ")[0];
    const k = `next.drop.${reason}` as Key;
    const s = t(k);
    if (s !== k) return s;
  }
  const key = `next.${x.kind}` as Key;
  const s = t(key);
  return s === key ? t("next.unknown") : s;
}

// VM stop → next step (shared with the VM page)
export function vmNextStep(cause: string | undefined, who: string | undefined, t: TFn): string {
  switch (cause) {
    case "cgroup_oom":
    case "host_oom":
    case "crash":
    case "shutdown":
      return t(`vm.next.${cause}` as Key);
    case "killed":
      return who ? t("vm.next.killed", { who }) : t("vm.next.killedUnknown");
    default:
      return t("vm.next.unknown");
  }
}

// "2026/9/28 17:58:11": the report's own timestamp always carries the date
export function stampFull(nowMs: number, lang: Lang): string {
  return new Date(nowMs).toLocaleString(lang === "ja" ? "ja-JP" : "en-GB", { hour12: false });
}

// The host report: headline, active incidents with owner and next step, the findings as evidence, the recent incidents
export function hostReport(args: {
  host: string; levelLabel: string; headline: string; findings: { area: string; lines: string[] }[];
  incidents: Incident[]; nowMs: number; lang: Lang; t: TFn; url: string;
}): string {
  const { host, levelLabel, headline, findings, incidents, nowMs, lang, t, url } = args;
  const active = activeIncidents(incidents, nowMs);
  const situation = active.length
    ? [headline, ...active.slice(0, 5).map((x) => incidentLine(x, lang, t))]
    : [headline, incidents[0] ? t("report.noneActiveLast", { line: incidentLine(incidents[0], lang, t) }) : t("report.noneActive")];
  // One next step and one owner per distinct kind, worst first (three is enough for a first message)
  const seen = new Set<string>();
  const firsts = active.filter((x) => (seen.has(x.kind) ? false : (seen.add(x.kind), true))).slice(0, 3);
  const next = firsts.map((x) => (firsts.length > 1 ? `${t(kindKey(x.kind))}: ` : "") + nextOf(x, t));
  const owner = firsts.map((x) => (firsts.length > 1 ? `${t(kindKey(x.kind))}: ` : "") + ownerOf(x, t));
  return formatReport(
    `${host} — ${levelLabel}: ${headline}`,
    t("report.meta", { time: stampFull(nowMs, lang), url }),
    [
      { title: t("report.situation"), lines: situation },
      { title: t("report.next"), lines: next.length ? next : [t("report.nextNone")] },
      { title: t("report.owner"), lines: owner.length ? owner : [t("report.ownerNone")] },
      { title: t("report.evidence"), lines: findings.filter((f) => f.lines.some(Boolean)).map((f) => `${f.area}: ${f.lines.filter(Boolean).join(" ")}`) },
      { title: t("report.recent"), lines: incidents.slice(0, 10).map((x) => incidentLine(x, lang, t)) },
    ],
  );
}
