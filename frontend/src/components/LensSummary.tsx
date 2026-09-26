import type { Sample } from "../types/model";
import { formatUs } from "../lib/hist";
import {
  LEVEL_COLOR, LEVEL_ICON, LEVEL_KEY, baseline, current, episodes, type Episode, type Level,
} from "../lib/lens";
import { explain, formatMs, impact, samplesBetween } from "../lib/impact";
import { lifecycleSentence, type Lifecycle } from "../lib/lifecycle";
import { currentMem, memorySentence } from "../lib/memory";
import { formatHM, formatTime, translate, useI18n, type Key, type Lang, type Params } from "../lib/i18n";

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

function lifecycleHeadline(l: Lifecycle): Key {
  if (l.ooms.length > 0) return "summary.life.oom";
  if (l.crashLoops.length > 0) return "summary.life.loop";
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

// "What is happening right now" summary shown at the top of the screen
export function LensSummary({ samples, memSamples, life }: { samples: Sample[]; memSamples: Sample[]; life: Lifecycle }) {
  const { lang, t } = useI18n();
  const now = current(samples);
  const util = cpuUtil(samples);
  const mem = currentMem(memSamples);
  // The overall status follows the worst area, and the headline uses that area's wording (ties: CPU -> memory -> processes)
  const areas: { level: Level; headline: Key }[] = [
    { level: now.level, headline: CPU_HEADLINE[now.level] },
    { level: mem.level, headline: MEM_HEADLINE[mem.level] },
    { level: life.level, headline: lifecycleHeadline(life) },
  ];
  const worstArea = areas.reduce((a, b) => (RANK[b.level] > RANK[a.level] ? b : a));
  const overall = worstArea.level;
  const headline = t(worstArea.headline);
  const base = baseline(samples);
  const eps = episodes(samples);
  const last = eps[0];

  let detail = "";
  if (now.p99 != null) {
    detail = t(now.level === "ok" ? "summary.p99Ok" : "summary.p99Bad", { p99: formatUs(now.p99) });
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
        <Finding area={t("resource.cpu")} level={now.level}>
          <p>{detail}</p>
          {last && <p>{episodeSentence(last, lang)}</p>}
          {last && <CauseSentence samples={samples} episode={last} />}
        </Finding>
        <Finding area={t("resource.memory")} level={mem.level}>
          <p>{memorySentence(memSamples, lang)}</p>
        </Finding>
        <Finding area={t("resource.processes")} level={life.level}>
          <p>{lifecycleSentence(life, lang)}</p>
        </Finding>
      </dl>

      {eps.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1 text-xs" style={{ color: "var(--text-muted)" }}>{t("summary.recentEpisodes")}</h3>
          <table className="w-full text-sm tabular">
            <thead style={{ color: "var(--text-muted)" }}>
              <tr>
                <th className="py-1 text-left font-normal">{t("summary.col.level")}</th>
                <th className="py-1 text-left font-normal">{t("summary.col.period")}</th>
                <th className="py-1 text-right font-normal">{t("summary.col.duration")}</th>
                <th className="py-1 text-right font-normal">{t("summary.col.peak")}</th>
              </tr>
            </thead>
            <tbody>
              {eps.map((e) => (
                <tr key={e.start.toISOString()} style={{ borderTop: "1px solid var(--grid)" }}>
                  <td className="py-1">
                    <span aria-hidden style={{ color: LEVEL_COLOR[e.level] }}>{LEVEL_ICON[e.level]}</span>{" "}
                    {t(LEVEL_KEY[e.level])}
                  </td>
                  <td className="py-1" style={{ color: "var(--text-secondary)" }}>
                    {formatTime(lang, e.start)}{t("range.sep")}{e.ongoing ? t("common.ongoing") : formatTime(lang, e.end)}
                  </td>
                  <td className="py-1 text-right">{t("common.seconds", { n: e.seconds })}</td>
                  <td className="py-1 text-right">{formatUs(e.peakUs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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

// One sentence on "who used the CPU and who else was kept waiting" during the episode
function CauseSentence({ samples, episode }: { samples: Sample[]; episode: Episode }) {
  const { t } = useI18n();
  const { culprit, victims } = explain(impact(samplesBetween(samples, episode.start, episode.end)));
  if (!culprit && victims.length === 0) return null;
  const parts: string[] = [];
  if (culprit) {
    const who = culprit.procs > 1 ? t("cause.who", { comm: culprit.comm, n: culprit.procs }) : culprit.comm;
    const pct = Math.round(culprit.cpuShare * 100);
    parts.push(t(episode.ongoing ? "cause.culpritOngoing" : "cause.culpritPast", { who, pct }));
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

function episodeSentence(e: Episode, lang: Lang): string {
  const tr = (k: Key, p?: Params) => translate(lang, k, p);
  const hm = (d: Date) => formatHM(lang, d);
  if (e.ongoing) {
    return tr("episode.ongoing", { start: hm(e.start), seconds: e.seconds, peak: formatUs(e.peakUs) });
  }
  const span = hm(e.start) === hm(e.end)
    ? tr("episode.spanAround", { t: hm(e.start) })
    : tr("episode.spanRange", { a: hm(e.start), b: hm(e.end) });
  return tr("episode.past", { span, peak: formatUs(e.peakUs), seconds: e.seconds });
}
