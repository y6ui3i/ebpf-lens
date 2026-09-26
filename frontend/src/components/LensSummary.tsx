import type { Sample } from "../types/model";
import { formatUs } from "../lib/hist";
import {
  LEVEL_COLOR, LEVEL_ICON, LEVEL_LABEL, baseline, current, episodes, type Episode, type Level,
} from "../lib/lens";
import { explain, formatMs, impact, samplesBetween } from "../lib/impact";

const HEADLINE: Record<Level, string> = {
  ok: "CPU待ち時間は低い状態です",
  caution: "CPU待ちがやや増えています",
  warning: "CPUの取り合いが起きています",
};

const hm = (d: Date) => d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });

// 画面の一番上に出す「今どうなっているか」の要約
export function LensSummary({ samples }: { samples: Sample[] }) {
  const now = current(samples);
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
  }

  return (
    <section
      className="mb-6 rounded-xl p-5"
      style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
      aria-live="polite"
    >
      <div className="mb-1 text-xs" style={{ color: "var(--text-muted)" }}>Lens Summary</div>
      <div className="flex items-center gap-2 text-lg font-semibold">
        <span aria-hidden style={{ color: LEVEL_COLOR[now.level] }}>{LEVEL_ICON[now.level]}</span>
        <span>{LEVEL_LABEL[now.level]}</span>
        <span style={{ color: "var(--text-secondary)" }}>·</span>
        <span>{HEADLINE[now.level]}</span>
      </div>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{detail}</p>
      {last && <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{episodeSentence(last)}</p>}
      {last && <CauseSentence samples={samples} episode={last} />}

      {eps.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1 text-xs" style={{ color: "var(--text-muted)" }}>直近の出来事(表示範囲内)</h3>
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
  return (
    <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
      {parts.join(" ")}
    </p>
  );
}

function episodeSentence(e: Episode): string {
  if (e.ongoing) {
    return `${hm(e.start)} から ${e.seconds} 秒間、高いCPU待ちが続いています(最大 ${formatUs(e.peakUs)})。`;
  }
  const span = hm(e.start) === hm(e.end) ? `${hm(e.start)}頃` : `${hm(e.start)}〜${hm(e.end)}`;
  return `${span}に高いCPU待ちが観測されました(最大 ${formatUs(e.peakUs)}、${e.seconds} 秒間)。`;
}
