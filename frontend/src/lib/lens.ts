// runqlat の数値を「監視者にとっての意味」に変換する。
// 判定はまだフロント側の仮実装。サーバー側のトリガーに移すまでの足場。
import type { Sample } from "../types/model";
import { percentile } from "./hist";

// しきい値(仮)。hal での実測: 平常時の 1 秒 p99 は約 30µs、GPU 推論(Demucs)中でも最大 476µs、
// stress-ng で 4 倍過負荷にすると 16ms。平常と過負荷のどちらからも十分離れた値にしている
export const CAUTION_US = 1_000;
export const WARNING_US = 10_000;

// 一瞬の山で判定を揺らさないための設定
const CURRENT_WINDOW = 5; // 現在の判定に使う秒数(p99 の中央値を取る)
const MIN_EPISODE_SECONDS = 3; // これより短い超過はイベントにしない
const MAX_GAP_SECONDS = 2; // この秒数以内の途切れは同じイベントとみなす

export type Level = "ok" | "caution" | "warning";

export function levelOf(us: number | null): Level {
  if (us == null || us < CAUTION_US) return "ok";
  return us < WARNING_US ? "caution" : "warning";
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const p99s = (samples: Sample[]) =>
  samples.map((s) => percentile(s.slots, 0.99)).filter((v): v is number => v != null);

// 現在の状態。直近数秒の p99 の中央値で判定する
export function current(samples: Sample[]) {
  const p99 = median(p99s(samples.slice(-CURRENT_WINDOW)));
  return { p99, level: levelOf(p99) };
}

// 平常時の目安。表示範囲のうち、しきい値未満だった秒の p99 の中央値
export function baseline(samples: Sample[]) {
  return median(p99s(samples).filter((v) => v < CAUTION_US));
}

export type Episode = {
  start: Date;
  end: Date;
  seconds: number;
  peakUs: number;
  level: Level;
  ongoing: boolean;
};

// p99 が注意しきい値を超えた区間を拾う。新しい順に返す
export function episodes(samples: Sample[]): Episode[] {
  const out: Episode[] = [];
  let open: { first: number; last: number; peak: number; warnSecs: number } | null = null;

  const close = () => {
    if (!open) return;
    const seconds = open.last - open.first + 1;
    if (seconds >= MIN_EPISODE_SECONDS) {
      out.push({
        start: new Date(samples[open.first].time),
        end: new Date(samples[open.last].time),
        seconds,
        peakUs: open.peak,
        // 警告しきい値を 3 秒以上超えたら警告、それ以外は注意
        level: open.warnSecs >= MIN_EPISODE_SECONDS ? "warning" : "caution",
        ongoing: open.last >= samples.length - 1 - MAX_GAP_SECONDS,
      });
    }
    open = null;
  };

  samples.forEach((s, i) => {
    const v = percentile(s.slots, 0.99);
    if (v != null && v >= CAUTION_US) {
      if (open && i - open.last > MAX_GAP_SECONDS + 1) close();
      if (!open) open = { first: i, last: i, peak: v, warnSecs: 0 };
      open.last = i;
      open.peak = Math.max(open.peak, v);
      if (v >= WARNING_US) open.warnSecs++;
    }
  });
  close();
  return out.reverse();
}

export const LEVEL_LABEL: Record<Level, string> = { ok: "正常", caution: "注意", warning: "警告" };
export const LEVEL_ICON: Record<Level, string> = { ok: "●", caution: "▲", warning: "◆" };
export const LEVEL_COLOR: Record<Level, string> = {
  ok: "var(--status-good)",
  caution: "var(--status-warning)",
  warning: "var(--status-critical)",
};
