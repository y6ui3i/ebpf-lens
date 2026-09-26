import type { Sample } from "../types/model";
import { formatRange, total } from "../lib/hist";

// 直近 1 区間のヒストグラムを表で見る(色に頼らない読み方)
export function HistogramTable({ sample }: { sample: Sample | undefined }) {
  if (!sample) return null;
  const n = total(sample.slots);
  const last = sample.slots.findLastIndex((v) => v > 0);
  const rows = sample.slots.slice(0, Math.max(last + 1, 1));
  return (
    <table className="w-full text-sm tabular">
      <caption className="pb-2 text-left text-xs" style={{ color: "var(--text-muted)" }}>
        {new Date(sample.time).toLocaleTimeString("ja-JP")} の 1 区間
      </caption>
      <thead style={{ color: "var(--text-muted)" }}>
        <tr>
          <th className="py-1 text-left font-normal">待ち時間</th>
          <th className="py-1 text-right font-normal">件数</th>
          <th className="py-1 text-right font-normal">割合</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c, i) => (
          <tr key={i} style={{ borderTop: "1px solid var(--grid)" }}>
            <td className="py-1" style={{ color: "var(--text-secondary)" }}>{formatRange(i)}</td>
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
