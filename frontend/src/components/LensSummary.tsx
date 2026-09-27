import type { Incident, Sample } from "../types/model";
import { formatUs } from "../lib/hist";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_KEY, baseline, current, type Level } from "../lib/lens";
import { areaLevel, asLevel, durationSeconds, isInstantKind, isOngoing, kindKey, latestOf } from "../lib/incidents";
import { explain, formatMs, impact, samplesBetween } from "../lib/impact";
import { lifecycleSentence, signalName, type Lifecycle } from "../lib/lifecycle";
import { formatMsPerSec, memorySentence } from "../lib/memory";
import { useTriggers } from "../lib/useTriggers";
import { formatHM, formatTime, translate, useI18n, type Key, type Lang, type Params, type TFn } from "../lib/i18n";

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
export function LensSummary({ samples, memSamples, life, incidents }: {
  samples: Sample[]; memSamples: Sample[]; life: Lifecycle; incidents: Incident[];
}) {
  const { lang, t } = useI18n();
  const triggers = useTriggers();
  const nowMs = Date.now();
  const now = current(samples);
  const util = cpuUtil(samples);
  const cpuLevel = areaLevel(incidents, ["cpu_wait"], nowMs);
  const memLevel = areaLevel(incidents, ["mem_stall"], nowMs);
  const procLevel = areaLevel(incidents, PROCESS_KINDS, nowMs);
  const agentDown = incidents.find((x) => x.kind === "agent_down" && isOngoing(x));
  // The overall status follows the worst area, and the headline uses that area's wording (ties: CPU -> memory -> processes).
  // A host that stopped reporting outranks everything, because no other data is fresh
  const areas: { level: Level; headline: Key }[] = [
    { level: cpuLevel, headline: CPU_HEADLINE[cpuLevel] },
    { level: memLevel, headline: MEM_HEADLINE[memLevel] },
    { level: procLevel, headline: lifecycleHeadline(incidents, nowMs) },
  ];
  const worstArea = areas.reduce((a, b) => (RANK[b.level] > RANK[a.level] ? b : a));
  const overall: Level = agentDown ? asLevel(agentDown.level) : worstArea.level;
  const headline = t(agentDown ? "summary.agentDown" : worstArea.headline);
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

  return (
    <section
      className="mb-6 rounded-xl p-5"
      style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
      aria-live="polite"
    >
      <div className="mb-1 text-xs" style={{ color: "var(--text-muted)" }}>Lens Summary</div>
      <div className="flex flex-wrap items-center gap-x-2 text-lg font-semibold">
        <span aria-hidden style={{ color: LEVEL_COLOR[overall] }}>{LEVEL_ICON[overall]}</span>
        <span>{t(LEVEL_KEY[overall])}</span>
        <span style={{ color: "var(--text-secondary)" }}>·</span>
        <span>{headline}</span>
      </div>

      <dl className="mt-3 space-y-2 text-sm">
        <Finding area={t("resource.cpu")} level={cpuLevel}>
          <p>{detail}</p>
          {last && <p>{episodeSentence(last, lang)}</p>}
          {last && <CauseSentence samples={samples} episode={last} />}
        </Finding>
        <Finding area={t("resource.memory")} level={memLevel}>
          <p>{memorySentence(memSamples, lang, memLevel)}</p>
        </Finding>
        <Finding area={t("resource.processes")} level={procLevel}>
          <p>{lifecycleSentence(life, lang)}</p>
        </Finding>
      </dl>

      {recent.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1 text-xs" style={{ color: "var(--text-muted)" }}>{t("summary.recentIncidents")}</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm tabular">
              <thead style={{ color: "var(--text-muted)" }}>
                <tr>
                  <th className="py-1 text-left font-normal">{t("summary.col.level")}</th>
                  <th className="py-1 text-left font-normal">{t("summary.col.kind")}</th>
                  <th className="py-1 text-left font-normal">{t("common.process")}</th>
                  <th className="py-1 text-left font-normal">{t("summary.col.period")}</th>
                  <th className="py-1 pr-4 text-right font-normal">{t("summary.col.duration")}</th>
                  <th className="py-1 text-left font-normal">{t("summary.col.detail")}</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((x) => {
                  const level = asLevel(x.level);
                  const secs = durationSeconds(x, nowMs);
                  return (
                    <tr key={x.id} style={{ borderTop: "1px solid var(--grid)" }}>
                      <td className="py-1 pr-2 whitespace-nowrap">
                        <span aria-hidden style={{ color: LEVEL_COLOR[level] }}>{LEVEL_ICON[level]}</span>{" "}
                        {t(LEVEL_KEY[level])}
                      </td>
                      <td className="py-1 pr-2">{t(kindKey(x.kind))}</td>
                      <td className="py-1 pr-2">{x.subject ?? ""}</td>
                      <td className="py-1 pr-2 whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
                        {timeSpan(x, lang, t)}
                      </td>
                      <td className="py-1 pr-4 text-right whitespace-nowrap">{secs == null ? "" : t("common.seconds", { n: secs })}</td>
                      <td className="py-1" style={{ color: "var(--text-secondary)" }}>{incidentDetail(x, lang, t)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
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

// "start – end" for the table; instant incidents show only their time
function timeSpan(x: Incident, lang: Lang, t: TFn): string {
  const start = formatTime(lang, x.start);
  if (isInstantKind(x.kind)) return start;
  return `${start}${t("range.sep")}${x.end ? formatTime(lang, x.end) : t("common.ongoing")}`;
}

// Short detail column per kind
function incidentDetail(x: Incident, lang: Lang, t: TFn): string {
  switch (x.kind) {
    case "cpu_wait":
      return x.peak == null ? "" : formatUs(x.peak);
    case "mem_stall":
      return formatMsPerSec(x.peak ?? null, lang);
    case "crash":
      return `${signalName(x.signal ?? 0, lang)}${x.coreDump ? t("lp.coreDump") : ""}`;
    case "oom_kill": {
      const why = t(x.memcg ? "mem.causeMemcg" : "incident.oomHost");
      return x.triggerComm ? why + t("incident.triggeredBy", { comm: x.triggerComm }) : why;
    }
    case "crash_loop":
      return t("incident.crashes", { n: x.count ?? x.peak ?? 0 });
    case "agent_down":
      return t("incident.silentFor", { n: x.seconds });
    default:
      return "";
  }
}

// One sentence on "who used the CPU and who else was kept waiting" during the incident
function CauseSentence({ samples, episode }: { samples: Sample[]; episode: Incident }) {
  const { t } = useI18n();
  const ongoing = isOngoing(episode);
  const end = ongoing ? new Date() : new Date(episode.end!);
  const { culprit, victims } = explain(impact(samplesBetween(samples, new Date(episode.start), end)));
  if (!culprit && victims.length === 0) return null;
  const parts: string[] = [];
  if (culprit) {
    const who = culprit.procs > 1 ? t("cause.who", { comm: culprit.comm, n: culprit.procs }) : culprit.comm;
    const pct = Math.round(culprit.cpuShare * 100);
    parts.push(t(ongoing ? "cause.culpritOngoing" : "cause.culpritPast", { who, pct }));
  } else {
    parts.push(t("cause.noCulprit"));
  }
  if (victims.length > 0) {
    const list = victims
      .map((x) => t("cause.victim", { comm: x.comm, total: formatMs(x.waitNs), p99: formatUs(x.p99) }))
      .join(t("list.sep"));
    parts.push(t(culprit ? "cause.victimsOthers" : "cause.victims", { list }));
  }
  return <p>{parts.join(" ")}</p>;
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
