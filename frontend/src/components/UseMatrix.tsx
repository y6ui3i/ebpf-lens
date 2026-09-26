import type { ProcEvent, Sample } from "../types/model";
import { formatUs, percentile } from "../lib/hist";
import { current, LEVEL_COLOR, LEVEL_ICON, LEVEL_LABEL, type Level } from "../lib/lens";
import type { Lifecycle } from "../lib/lifecycle";
import type { TimeWindow } from "../lib/timeWindow";
import { Link } from "../lib/router";
import { Sparkline } from "./Sparkline";

// USE メソッド(Brendan Gregg): 資源ごとに 使用率 / 飽和 / エラー を見る。
// プローブが増えても升目が埋まっていくだけで、画面は縦に伸びない

type Cell =
  | { kind: "value"; value: string; note: string; level?: Level; spark?: (number | null)[]; log?: boolean; to?: string }
  | { kind: "planned"; roadmap: string }
  | { kind: "na" };

type Row = { resource: string; cells: [Cell, Cell, Cell] };

const COLUMNS = [
  { title: "使用率", hint: "どれだけ使っているか" },
  { title: "飽和", hint: "足りずに待たされているか" },
  { title: "エラー", hint: "失敗や強制終了" },
];

export function UseMatrix({ samples, events, life, win }: { samples: Sample[]; events: ProcEvent[]; life: Lifecycle; win: TimeWindow }) {
  const utilSeries = samples.map((s) => (s.cpus && s.intervalMs ? s.busyNs / (s.intervalMs * 1e6 * s.cpus) : null));
  const util = mean(utilSeries.slice(-5));
  const cpuNow = current(samples);
  const p99Series = samples.map((s) => percentile(s.slots, 0.99));
  const execSeries = perSecond(events.filter((e) => e.kind === "exec"), win);
  const crashLevel: Level = life.crashLoops.length > 0 ? "warning" : life.crashes.length > 0 ? "caution" : "ok";

  const rows: Row[] = [
    {
      resource: "CPU",
      cells: [
        { kind: "value", value: util == null ? "–" : `${Math.round(util * 100)}%`, note: "直近5秒の平均", spark: utilSeries, to: "/cpu" },
        {
          kind: "value", value: formatUs(cpuNow.p99), note: "99%のタスクがCPUを得るまでの待ち",
          level: cpuNow.level, spark: p99Series, log: true, to: "/cpu",
        },
        { kind: "na" },
      ],
    },
    {
      resource: "メモリ",
      cells: [
        { kind: "planned", roadmap: "6" },
        { kind: "planned", roadmap: "6" },
        {
          kind: "value", value: `${life.ooms.length}`, note: "OOM kill(直近5分)",
          level: life.ooms.length > 0 ? "warning" : "ok", to: "/processes",
        },
      ],
    },
    {
      resource: "プロセス",
      cells: [
        { kind: "value", value: `${life.execs.toLocaleString()}`, note: "起動(直近5分)", spark: execSeries, to: "/processes" },
        { kind: "na" },
        { kind: "value", value: `${life.crashes.length}`, note: "クラッシュ(直近5分)", level: crashLevel, to: "/processes" },
      ],
    },
    { resource: "ディスク", cells: [{ kind: "planned", roadmap: "10" }, { kind: "planned", roadmap: "10" }, { kind: "planned", roadmap: "10" }] },
    { resource: "ネットワーク", cells: [{ kind: "planned", roadmap: "10" }, { kind: "planned", roadmap: "10" }, { kind: "planned", roadmap: "10" }] },
    { resource: "GPU", cells: [{ kind: "planned", roadmap: "8" }, { kind: "planned", roadmap: "9" }, { kind: "planned", roadmap: "8" }] },
  ];

  return (
    <section className="rounded-xl p-5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
      <div className="mb-3">
        <h2 className="text-lg font-semibold">資源ごとの状態</h2>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>USE メソッド: 資源ごとに使用率・飽和・エラーを見る。升目を押すと詳しい画面へ</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] table-fixed text-sm tabular">
          <thead>
            <tr style={{ color: "var(--text-muted)" }}>
              <th className="w-24 py-1 text-left font-normal" />
              {COLUMNS.map((c) => (
                <th key={c.title} className="px-2 py-1 text-left font-normal">
                  <span style={{ color: "var(--text-secondary)" }}>{c.title}</span>
                  <span className="ml-1 text-xs">{c.hint}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.resource} style={{ borderTop: "1px solid var(--grid)" }}>
                <th className="py-2 text-left align-top font-semibold">{r.resource}</th>
                {r.cells.map((c, i) => (
                  <td key={i} className="px-2 py-2 align-top">
                    <CellView cell={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CellView({ cell }: { cell: Cell }) {
  if (cell.kind === "na") return <span style={{ color: "var(--text-muted)" }}>—</span>;
  if (cell.kind === "planned") {
    return <span className="text-xs" style={{ color: "var(--text-muted)" }}>未実装(ロードマップ {cell.roadmap})</span>;
  }
  // 正常なら静かに、注意・警告のときだけアイコンと色を付ける
  const alert = cell.level && cell.level !== "ok";
  const body = (
    <>
      <div className="flex items-baseline gap-1.5">
        {alert && (
          <span aria-hidden style={{ color: LEVEL_COLOR[cell.level!] }}>{LEVEL_ICON[cell.level!]}</span>
        )}
        <span className={alert ? "text-lg font-semibold" : "text-lg"}>{cell.value}</span>
        {alert && <span className="text-xs" style={{ color: "var(--text-secondary)" }}>{LEVEL_LABEL[cell.level!]}</span>}
      </div>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>{cell.note}</div>
      {cell.spark && <div className="mt-1"><Sparkline values={cell.spark} log={cell.log} label={`${cell.note}の直近5分の推移`} /></div>}
    </>
  );
  if (!cell.to) return body;
  return (
    <Link to={cell.to} className="-m-1 block rounded-md p-1 hover:bg-[var(--page)]">
      {body}
    </Link>
  );
}

function mean(xs: (number | null)[]): number | null {
  const k = xs.filter((v): v is number => v != null);
  return k.length ? k.reduce((a, b) => a + b, 0) / k.length : null;
}

// イベントを 1 秒ごとの件数にする(表示範囲に合わせる)
function perSecond(events: ProcEvent[], win: TimeWindow): number[] {
  const n = Math.round((win.endMs - win.startMs) / 1000) + 1;
  const out = new Array<number>(n).fill(0);
  for (const e of events) {
    const i = Math.round((Date.parse(e.time) - win.startMs) / 1000);
    if (i >= 0 && i < n) out[i]++;
  }
  return out;
}
