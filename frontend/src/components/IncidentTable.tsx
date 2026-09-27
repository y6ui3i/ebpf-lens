import type { Incident } from "../types/model";
import { formatUs } from "../lib/hist";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_KEY } from "../lib/lens";
import { asLevel, durationSeconds, isInstantKind, kindKey } from "../lib/incidents";
import { signalName } from "../lib/lifecycle";
import { formatMsPerSec } from "../lib/memory";
import { formatTime, useI18n, type Key, type Lang, type TFn } from "../lib/i18n";

// The incidents table used by the dashboard's Lens Summary and by the VM page (same columns, so a reader learns it once)
export function IncidentTable({ incidents, nowMs }: { incidents: Incident[]; nowMs: number }) {
  const { lang, t } = useI18n();
  return (
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
          {incidents.map((x) => {
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
  );
}

// "start – end" for the table; instant incidents show only their time
export function timeSpan(x: Incident, lang: Lang, t: TFn): string {
  const start = formatTime(lang, x.start);
  if (isInstantKind(x.kind)) return start;
  return `${start}${t("range.sep")}${x.end ? formatTime(lang, x.end) : t("common.ongoing")}`;
}

// Short detail column per kind
export function incidentDetail(x: Incident, lang: Lang, t: TFn): string {
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
    case "vm_down": {
      const causeKey = (`incident.cause.${x.cause ?? "shutdown"}` as Key);
      let d = t(causeKey);
      if (x.cause === "crash" && x.signal) d += ` (${signalName(x.signal, lang)})`;
      if (x.triggerComm) d += t("incident.by", { comm: x.triggerComm });
      return d;
    }
    default:
      return "";
  }
}
