import type { Sample } from "../types/model";
import { formatRange, total } from "../lib/hist";
import { formatTime, useI18n } from "../lib/i18n";

// The latest interval's histogram as a table (a way to read it without relying on color)
export function HistogramTable({ sample }: { sample: Sample | undefined }) {
  const { lang, t } = useI18n();
  if (!sample) return null;
  const n = total(sample.slots);
  const last = sample.slots.findLastIndex((v) => v > 0);
  const rows = sample.slots.slice(0, Math.max(last + 1, 1));
  return (
    <table className="w-full text-sm tabular">
      <caption className="pb-2 text-left text-xs" style={{ color: "var(--text-muted)" }}>
        {t("hist.caption", { time: formatTime(lang, sample.time) })}
      </caption>
      <thead style={{ color: "var(--text-muted)" }}>
        <tr>
          <th className="py-1 text-left font-normal">{t("hist.wait")}</th>
          <th className="py-1 text-right font-normal">{t("hist.count")}</th>
          <th className="py-1 text-right font-normal">{t("hist.share")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c, i) => (
          <tr key={i} style={{ borderTop: "1px solid var(--grid)" }}>
            <td className="py-1" style={{ color: "var(--text-secondary)" }}>{formatRange(i, lang)}</td>
            <td className="py-1 text-right">{c.toLocaleString()}</td>
            <td className="py-1 text-right" style={{ color: "var(--text-secondary)" }}>
              {n ? `${((c / n) * 100).toFixed(1)}%` : "–"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
