import type { Sample } from "../types/model";
import { formatUs } from "../lib/hist";
import {
  LEVEL_COLOR, LEVEL_ICON, LEVEL_LABEL, baseline, current, episodes, type Episode, type Level,
} from "../lib/lens";
import { explain, formatMs, impact, samplesBetween } from "../lib/impact";
import { lifecycleSentence, type Lifecycle } from "../lib/lifecycle";
import { currentMem, memorySentence } from "../lib/memory";

const CPU_HEADLINE: Record<Level, string> = {
  ok: "CPU待ち時間は低い状態です",
  caution: "CPU待ちがやや増えています",
  warning: "CPUの取り合いが起きています",
};

const RANK: Record<Level, number> = { ok: 0, caution: 1, warning: 2 };

const MEM_HEADLINE: Record<Level, string> = {
  ok: "",
  caution: "メモリ不足でプロセスが止まり始めています",
  warning: "メモリ不足でプロセスが大きく止まっています",
};

function lifecycleHeadline(l: Lifecycle): string {
  if (l.ooms.length > 0) return "メモリ不足でプロセスが強制終了されました";
  if (l.crashLoops.length > 0) return "クラッシュを繰り返しているプロセスがあります";
  return "異常終了したプロセスがあります";
}

// CPU 使用率(eBPF で計測した全プロセスの CPU 時間の合計から出す)
function cpuUtil(samples: Sample[]): number | null {
  const xs = samples.slice(-5).filter((s) => s.cpus > 0 && s.intervalMs > 0);
  if (xs.length === 0) return null;
  const busy = xs.reduce((a, s) => a + s.busyNs, 0);
  const cap = xs.reduce((a, s) => a + s.intervalMs * 1e6 * s.cpus, 0);
  return Math.min(1, busy / cap);
}

const hm = (d: Date) => d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });

// 画面の一番上に出す「今どうなっているか」の要約
export function LensSummary({ samples, memSamples, life }: { samples: Sample[]; memSamples: Sample[]; life: Lifecycle }) {
  const now = current(samples);
  const util = cpuUtil(samples);
  const mem = currentMem(memSamples);
  // 全体の判定は一番悪い領域に合わせ、見出しもその領域の言葉にする(同点なら CPU → メモリ → プロセスの順)
  const areas: { level: Level; headline: string }[] = [
    { level: now.level, headline: CPU_HEADLINE[now.level] },
    { level: mem.level, headline: MEM_HEADLINE[mem.level] },
    { level: life.level, headline: lifecycleHeadline(life) },
  ];
  const worstArea = areas.reduce((a, b) => (RANK[b.level] > RANK[a.level] ? b : a));
  const overall = worstArea.level;
  const headline = worstArea.headline;
  const base = baseline(samples);
  const eps = episodes(samples);
  const last = eps[0];

  let detail = "";
  if (now.p99 != null) {
    detail =
      now.level === "ok"
        ? `99%のタスクが ${formatUs(now.p99)} 以内にCPUを獲得しています`
        : `99%のタスクがCPUを得るまで最大 ${formatUs(now.p99)} 待たされています`;
    if (base != null) {
      const ratio = now.p99 / base;
      detail += ratio >= 3 ? `(平常時 ${formatUs(base)} の約${Math.round(ratio)}倍)。` : `(平常時 ${formatUs(base)})。`;
    } else {
      detail += "。";
    }
    if (util != null) detail += ` CPU使用率は ${Math.round(util * 100)}% です。`;
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
        <span>{LEVEL_LABEL[overall]}</span>
        <span style={{ color: "var(--text-secondary)" }}>·</span>
        <span>{headline}</span>
      </div>

      <dl className="mt-3 space-y-2 text-sm">
        <Finding area="CPU" level={now.level}>
          <p>{detail}</p>
          {last && <p>{episodeSentence(last)}</p>}
          {last && <CauseSentence samples={samples} episode={last} />}
        </Finding>
        <Finding area="メモリ" level={mem.level}>
          <p>{memorySentence(memSamples)}</p>
        </Finding>
        <Finding area="プロセス" level={life.level}>
          <p>{lifecycleSentence(life)}</p>
        </Finding>
      </dl>

      {eps.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1 text-xs" style={{ color: "var(--text-muted)" }}>CPU の直近の出来事(表示範囲内)</h3>
          <table className="w-full text-sm tabular">
            <thead style={{ color: "var(--text-muted)" }}>
              <tr>
                <th className="py-1 text-left font-normal">レベル</th>
                <th className="py-1 text-left font-normal">時間帯</th>
                <th className="py-1 text-right font-normal">継続</th>
                <th className="py-1 text-right font-normal">最大待ち(p99)</th>
              </tr>
            </thead>
            <tbody>
              {eps.map((e) => (
                <tr key={e.start.toISOString()} style={{ borderTop: "1px solid var(--grid)" }}>
                  <td className="py-1">
                    <span aria-hidden style={{ color: LEVEL_COLOR[e.level] }}>{LEVEL_ICON[e.level]}</span>{" "}
                    {LEVEL_LABEL[e.level]}
                  </td>
                  <td className="py-1" style={{ color: "var(--text-secondary)" }}>
                    {e.start.toLocaleTimeString("ja-JP")} 〜 {e.ongoing ? "継続中" : e.end.toLocaleTimeString("ja-JP")}
                  </td>
                  <td className="py-1 text-right">{e.seconds} 秒</td>
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

// 領域ごとの所見。アイコンとラベルで判定を示し、色だけに頼らない
function Finding({ area, level, children }: { area: string; level: Level; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[5.5rem_1fr] sm:gap-2">
      <dt className="flex items-start gap-1.5 font-semibold">
        <span aria-hidden style={{ color: LEVEL_COLOR[level] }}>{LEVEL_ICON[level]}</span>
        <span>{area}</span>
        <span className="sr-only">{LEVEL_LABEL[level]}</span>
      </dt>
      <dd className="space-y-0.5" style={{ color: "var(--text-secondary)" }}>{children}</dd>
    </div>
  );
}

// 出来事の間に「誰が CPU を使い、ほかに誰が待たされたか」を一文にする
function CauseSentence({ samples, episode }: { samples: Sample[]; episode: Episode }) {
  const { culprit, victims } = explain(impact(samplesBetween(samples, episode.start, episode.end)));
  if (!culprit && victims.length === 0) return null;
  const tense = episode.ongoing ? "います" : "いました";
  const parts: string[] = [];
  if (culprit) {
    const who = culprit.procs > 1 ? `${culprit.comm}(${culprit.procs}プロセス)` : culprit.comm;
    parts.push(`原因: ${who} がCPU全体の${Math.round(culprit.cpuShare * 100)}%を使って${tense}。`);
  } else {
    parts.push("特定のプロセスがCPUを占有していたわけではありません。");
  }
  if (victims.length > 0) {
    const v = victims
      .map((x) => `${x.comm}(合計 ${formatMs(x.waitNs)}、99%は ${formatUs(x.p99)} 以内)`)
      .join("、");
    parts.push(`${culprit ? "そのほかで" : ""}待たされたのは ${v} です。`);
  }
  return <p>{parts.join(" ")}</p>;
}

function episodeSentence(e: Episode): string {
  if (e.ongoing) {
    return `${hm(e.start)} から ${e.seconds} 秒間、高いCPU待ちが続いています(最大 ${formatUs(e.peakUs)})。`;
  }
  const span = hm(e.start) === hm(e.end) ? `${hm(e.start)}頃` : `${hm(e.start)}〜${hm(e.end)}`;
  return `${span}に高いCPU待ちが観測されました(最大 ${formatUs(e.peakUs)}、${e.seconds} 秒間)。`;
}
