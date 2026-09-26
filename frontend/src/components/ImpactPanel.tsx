import { useState } from "react";
import type { Sample } from "../types/model";
import { formatUs } from "../lib/hist";
import { episodes } from "../lib/lens";
import { byCpu, byWait, explain, formatMs, impact, procLabel, samplesBetween } from "../lib/impact";

const RECENT_SECONDS = 10;
const ROWS = 5;

type Scope = "episode" | "recent";

// 原因(誰が CPU を使っていたか)と影響(誰が待たされたか)
export function ImpactPanel({ samples }: { samples: Sample[] }) {
  const ep = episodes(samples)[0];
  const [picked, setPicked] = useState<Scope>();
  const scope: Scope = picked ?? (ep ? "episode" : "recent");

  const range = scope === "episode" && ep ? samplesBetween(samples, ep.start, ep.end) : samples.slice(-RECENT_SECONDS);
  const xs = impact(range);
  const { culprit } = explain(xs);
  const cpu = byCpu(xs).slice(0, ROWS);
  const wait = byWait(xs).slice(0, ROWS);
  const maxShare = Math.max(...cpu.map((x) => x.cpuShare), 0.01);

  const scopeLabel =
    scope === "episode" && ep
      ? `出来事 ${ep.start.toLocaleTimeString("ja-JP")} 〜 ${ep.ongoing ? "継続中" : ep.end.toLocaleTimeString("ja-JP")}`
      : `直近 ${RECENT_SECONDS} 秒`;

  return (
    <section
      className="rounded-xl p-5"
      style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">原因と影響</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            誰がCPUを使っていて、誰が待たされたか({scopeLabel})
          </p>
        </div>
        {ep && (
          <div className="flex gap-1 text-xs" role="group" aria-label="集計する範囲">
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
                {s === "episode" ? "直近の出来事" : `直近 ${RECENT_SECONDS} 秒`}
              </button>
            ))}
          </div>
        )}
      </div>

      {xs.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          プロセス別のデータがまだありません(エージェントが古い可能性があります)
        </p>
      ) : (
        <div className="grid gap-8 md:grid-cols-2">
          <div>
            <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>
              CPUを使っていたプロセス
            </h3>
            <table className="w-full text-sm tabular">
              <thead style={{ color: "var(--text-muted)" }}>
                <tr>
                  <th className="py-1 text-left font-normal">プロセス</th>
                  <th className="py-1 text-left font-normal">CPU全体に占める割合</th>
                  <th className="py-1 text-right font-normal">CPU時間</th>
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
              待たされていたプロセス
            </h3>
            <table className="w-full text-sm tabular">
              <thead style={{ color: "var(--text-muted)" }}>
                <tr>
                  <th className="py-1 text-left font-normal">プロセス</th>
                  <th className="py-1 text-right font-normal">待ちの合計</th>
                  <th className="py-1 text-right font-normal">回数</th>
                  <th className="py-1 text-right font-normal">99%は以内</th>
                  <th className="py-1 text-right font-normal">最大</th>
                </tr>
              </thead>
              <tbody>
                {wait.map((x) => (
                  <tr key={x.comm} style={{ borderTop: "1px solid var(--grid)" }}>
                    <td className="py-1.5 pr-2">
                      {procLabel(x)}
                      {x.comm === culprit?.comm && (
                        <span className="ml-1 text-xs" style={{ color: "var(--text-muted)" }}>(原因側)</span>
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
        同じ名前のプロセスはまとめて表示。エージェントは1秒ごとに上位のプロセスだけを送るため、合計は近似値です
      </p>
    </section>
  );
}
