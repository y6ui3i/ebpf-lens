import { useState } from "react";
import type { ProcEvent } from "../types/model";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_KEY, type Level } from "../lib/lens";
import { formatTime, translate, useI18n, type Key, type Lang } from "../lib/i18n";
import { formatLifetime, isCrash, isErrorExit, signalName, type Lifecycle } from "../lib/lifecycle";

const LOG_ROWS = 30;

// Process starts, exits and kills. Lists even short-lived processes that polling monitors cannot see, one by one.
// `level` is the process area's level from the server's incidents (oom_kill / crash / crash_loop)
export function LifecyclePanel({ events, life, dropped, level }: {
  events: ProcEvent[]; life: Lifecycle; dropped: number; level: Level;
}) {
  const { lang, t } = useI18n();
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
      <h2 className="text-lg font-semibold">{t("page.processes")}</h2>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>Process lifecycle · exec / exit / oom</div>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        {t("lp.desc")}
      </p>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Tile label={t("lp.tileExec")} value={life.execs} note={t("lp.tileExecNote")} />
        <Tile label={t("lp.tileShort")} value={life.shortLived} note={t("lp.tileShortNote")} />
        <Tile label={t("lp.tileErr")} value={life.errorExits} note={t("lp.tileErrNote")} />
        <Tile
          label={t("lp.tileCrash")}
          value={life.crashes.length + life.ooms.length}
          note={t("lp.tileCrashNote")}
          level={level}
        />
      </div>

      {notable.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("lp.notableTitle")}</h3>
          <table className="w-full text-sm tabular">
            <tbody>
              {notable.slice(0, 10).map((e, i) => (
                <tr key={i} style={{ borderTop: "1px solid var(--grid)" }}>
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    <span aria-hidden style={{ color: LEVEL_COLOR[e.kind === "oom" ? "warning" : "caution"] }}>
                      {LEVEL_ICON[e.kind === "oom" ? "warning" : "caution"]}
                    </span>{" "}
                    {t(e.kind === "oom" ? "lp.kind.oom" : "lp.crash")}
                  </td>
                  <td className="py-1.5 pr-3" style={{ color: "var(--text-secondary)" }}>{formatTime(lang, e.time)}</td>
                  <td className="py-1.5 pr-3">{e.comm} <span style={{ color: "var(--text-muted)" }}>pid {e.pid}</span></td>
                  <td className="py-1.5" style={{ color: "var(--text-secondary)" }}>{describe(e, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-5 grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("lp.shortTitle")}</h3>
          <p className="mb-1 text-xs" style={{ color: "var(--text-muted)" }}>{t("lp.shortNote")}</p>
          {life.shortLivedByComm.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>{t("common.none")}</p>
          ) : (
            <table className="w-full text-sm tabular">
              <thead style={{ color: "var(--text-muted)" }}>
                <tr>
                  <th className="py-1 text-left font-normal">{t("lp.colCommand")}</th>
                  <th className="py-1 text-right font-normal">{t("common.count")}</th>
                  <th className="py-1 text-right font-normal">{t("lp.colMedian")}</th>
                  <th className="py-1 text-right font-normal">{t("lp.colMin")}</th>
                </tr>
              </thead>
              <tbody>
                {life.shortLivedByComm.slice(0, 8).map((c) => (
                  <tr key={c.comm} style={{ borderTop: "1px solid var(--grid)" }}>
                    <td className="py-1.5">{c.comm}</td>
                    <td className="py-1.5 text-right">{c.count.toLocaleString()}</td>
                    <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatLifetime(c.medianNs, lang)}</td>
                    <td className="py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{formatLifetime(c.minNs, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{t("lp.logTitle")}</h3>
            <label className="flex items-center gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>
              <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
              {t("lp.onlyProblems")}
            </label>
          </div>
          <p className="mb-1 text-xs" style={{ color: "var(--text-muted)" }}>{t("lp.logNote", { n: LOG_ROWS })}</p>
          <table className="w-full text-sm tabular">
            <tbody>
              {log.map((e, i) => (
                <tr key={i} style={{ borderTop: "1px solid var(--grid)" }}>
                  <td className="py-1 pr-2 whitespace-nowrap" style={{ color: "var(--text-muted)" }}>{formatTime(lang, e.time)}</td>
                  <td className="py-1 pr-2 whitespace-nowrap">{KIND_KEY[e.kind] ? t(KIND_KEY[e.kind]) : e.kind}</td>
                  <td className="py-1 pr-2">{e.comm}</td>
                  <td className="py-1 break-all" style={{ color: "var(--text-secondary)" }}>{describe(e, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {dropped > 0 && (
        <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
          {t("lp.dropped", { n: dropped.toLocaleString() })}
        </p>
      )}
    </section>
  );
}

const KIND_KEY: Record<string, Key> = { exec: "lp.kind.exec", exit: "lp.kind.exit", oom: "lp.kind.oom" };

function describe(e: ProcEvent, lang: Lang): string {
  switch (e.kind) {
    case "exec":
      return e.filename ?? "";
    case "exit": {
      const life = translate(lang, "lp.lifetime", { v: formatLifetime(e.lifetimeNs, lang) });
      if (e.signal) return `${signalName(e.signal, lang)}${e.coreDump ? translate(lang, "lp.coreDump") : ""} · ${life}`;
      return e.exitStatus ? `${translate(lang, "lp.exitCode", { n: e.exitStatus })} · ${life}` : life;
    }
    case "signal":
      return translate(lang, "lp.signalDesc", { sig: signalName(e.signal, lang), comm: String(e.triggerComm), pid: String(e.triggerPid) });
    case "oom": {
      const mb = Math.round(((e.totalPages ?? 0) * 4096) / 1024 / 1024);
      const scope = translate(lang, e.memcg ? "lp.scopeMemcg" : "lp.scopeHost", { mb });
      return translate(lang, "lp.oomDesc", { scope, comm: String(e.triggerComm), pid: String(e.triggerPid) });
    }
  }
  return "";
}

function Tile({ label, value, note, level }: { label: string; value: number; note: string; level?: "ok" | "caution" | "warning" }) {
  const { t } = useI18n();
  return (
    <div>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</div>
      <div className="flex items-center gap-1.5 text-2xl font-semibold">
        {level && level !== "ok" && (
          <span aria-hidden className="text-base" style={{ color: LEVEL_COLOR[level] }}>{LEVEL_ICON[level]}</span>
        )}
        {value.toLocaleString()}
        {level && level !== "ok" && <span className="sr-only">{t(LEVEL_KEY[level])}</span>}
      </div>
      <div className="text-xs" style={{ color: "var(--text-secondary)" }}>{note}</div>
    </div>
  );
}
