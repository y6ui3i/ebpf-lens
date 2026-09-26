import type { Sample } from "../types/model";

// ヒートマップと推移グラフで共有する表示範囲。横に並べても同じ時刻が同じ割合の位置に来るようにする
export type TimeWindow = { startMs: number; endMs: number };

export function timeWindow(samples: Sample[], seconds: number): TimeWindow {
  const last = samples.at(-1);
  const endMs = last ? Date.parse(last.time) : Date.now();
  return { startMs: endMs - (seconds - 1) * 1000, endMs };
}
