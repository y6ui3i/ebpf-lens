import type { Sample } from "../types/model";

// Time range shared by the heatmap and the trend chart, so the same time lands at the same relative position when they sit side by side
export type TimeWindow = { startMs: number; endMs: number };

export function timeWindow(samples: Sample[], seconds: number): TimeWindow {
  const last = samples.at(-1);
  const endMs = last ? Date.parse(last.time) : Date.now();
  return { startMs: endMs - (seconds - 1) * 1000, endMs };
}
