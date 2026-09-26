import { useState } from "react";
import type { ProcEvent } from "../types/model";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_LABEL } from "../lib/lens";
import { formatLifetime, isCrash, isErrorExit, signalName, type Lifecycle } from "../lib/lifecycle";

const LOG_ROWS = 30;

// プロセスの起動・終了・強制終了。ポーリング型の監視では見えない短命なプロセスも 1 件ずつ出す
export function LifecyclePanel({ events, life, dropped }: { events: ProcEvent[]; life: Lifecycle; dropped: number }) {
  const [onlyProblems, setOnlyProblems] = useState(false);
  const notable = [...life.ooms, ...life.crashes].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  const log = events
    .filter((e) => !onlyProblems || e.kind === "oom" || isCrash(e) || isErrorExit(e))
    .slice(-LOG_ROWS)
    .reverse();

  return (
    <section
      className="rounded-xl p-5"
      style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
    >
      <h2 className="text-lg font-semibold">プロセスの起動と終了</h2>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>Process lifecycle · exec / exit / oom</div>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        プロセスが起動・終了・強制終了された記録(直近5分)。一瞬で終わるプロセスも1件ずつ拾います
      </p>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Tile label="起動" value={life.execs} note="exec の回数" />
        <Tile label="1秒未満で終了" value={life.shortLived} note="数十秒ごとに値を取る監視では見えない" />
        <Tile label="エラー終了" value={life.errorExits} note="終了コードが0以外(判定には使わない)" />
        <Tile
          label="クラッシュ / OOM"
          value={life.crashes.length + life.ooms.length}
          note="SIGSEGV などの異常終了と、メモリ不足による強制終了"
          level={life.level}
        />
      </div>

      {notable.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>異常な終わり方をしたプロセス</h3>
          <table className="w-full text-sm tabular">
            <tbody>
              {notable.slice(0, 10).map((e, i) => (
                <tr key={i} style={{ borderTop: "1px solid var(--grid)" }}>
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    <span aria-hidden style={{ color: LEVEL_COLOR[e.kind === "oom" ? "warning" : "caution"] }}>
                      {LEVEL_ICON[e.kind === "oom" ? "warning" : "caution"]}
                    </span>{" "}
                    {e.kind === "oom" ? "OOM kill" : "クラッシュ"}
                  </td>
                  <td className="py-1.5 pr-3" style={{ color: "var(--text-secondary)" }}>{new Date(e.time).toLocaleTimeString("ja-JP")}</td>
                  <td className="py-1.5 pr-3">{e.comm} <span style={{ color: "var(--text-muted)" }}>pid {e.pid}</span></td>
                  <td className="py-1.5" style={{ color: "var(--text-secondary)" }}>{describe(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-5 grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>1秒未満で終わったプロセス</h3>
          <p className="mb-1 text-xs" style={{ color: "var(--text-muted)" }}>cron やスクリプトから呼ばれる一瞬のコマンド。多すぎると CPU を細かく食う</p>
          {life.shortLivedByComm.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>ありません</p>
          ) : (
            <table className="w-full text-sm tabular">
              <thead style={{ color: "var(--text-muted)" }}>
                <tr>
                  <th className="py-1 text-left font-normal">コマンド</th>
                  <th className="py-1 text-right font-normal">回数</th>
                  <th className="py-1 text-right font-normal">寿命(中央値)</th>
                  <th className="py-1 text-right font-normal">最短</th>
                </tr>
              </thead>
              <tbody>
                {life.shortLivedByComm.slice(0, 8).map((c) => (
                  <tr key={c.comm} style={{ borderTop: "1px solid var(--grid)" }}>
                    <td className="py-1.5">{c.comm}</td>
                    <td className="py-1.5 text-right">{c.count.toLocaleString()}</td>
                    <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatLifetime(c.medianNs)}</td>
                    <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatLifetime(c.minNs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>最近の記録</h3>
            <label className="flex items-center gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>
              <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
              異常のみ
            </label>
          </div>
          <p className="mb-1 text-xs" style={{ color: "var(--text-muted)" }}>新しい順に {LOG_ROWS} 件。コマンドライン引数は記録しない</p>
          <table className="w-full text-sm tabular">
            <tbody>
              {log.map((e, i) => (
                <tr key={i} style={{ borderTop: "1px solid var(--grid)" }}>
                  <td className="py-1 pr-2 whitespace-nowrap" style={{ color: "var(--text-muted)" }}>{new Date(e.time).toLocaleTimeString("ja-JP")}</td>
                  <td className="py-1 pr-2 whitespace-nowrap">{KIND_LABEL[e.kind] ?? e.kind}</td>
                  <td className="py-1 pr-2">{e.comm}</td>
                  <td className="py-1 break-all" style={{ color: "var(--text-secondary)" }}>{describe(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {dropped > 0 && (
        <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
          処理が追いつかず {dropped.toLocaleString()} 件のイベントを取りこぼしました
        </p>
      )}
    </section>
  );
}

const KIND_LABEL: Record<string, string> = { exec: "起動", exit: "終了", oom: "OOM kill" };

function describe(e: ProcEvent): string {
  switch (e.kind) {
    case "exec":
      return e.filename ?? "";
    case "exit": {
      const life = `寿命 ${formatLifetime(e.lifetimeNs)}`;
      if (e.signal) return `${signalName(e.signal)}${e.coreDump ? "(コアダンプ)" : ""} · ${life}`;
      return e.exitStatus ? `終了コード ${e.exitStatus} · ${life}` : life;
    }
    case "oom": {
      const mb = Math.round(((e.totalPages ?? 0) * 4096) / 1024 / 1024);
      const scope = e.memcg ? `cgroup の上限(${mb} MB)` : `ホスト全体(${mb} MB)`;
      return `${scope}に達して強制終了 · 要求したのは ${e.triggerComm}(pid ${e.triggerPid})`;
    }
  }
  return "";
}

function Tile({ label, value, note, level }: { label: string; value: number; note: string; level?: "ok" | "caution" | "warning" }) {
  return (
    <div>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</div>
      <div className="flex items-center gap-1.5 text-2xl font-semibold">
        {level && level !== "ok" && (
          <span aria-hidden className="text-base" style={{ color: LEVEL_COLOR[level] }}>{LEVEL_ICON[level]}</span>
        )}
        {value.toLocaleString()}
        {level && level !== "ok" && <span className="sr-only">{LEVEL_LABEL[level]}</span>}
      </div>
      <div className="text-xs" style={{ color: "var(--text-secondary)" }}>{note}</div>
    </div>
  );
}
