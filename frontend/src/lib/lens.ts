// Turns runqlat numbers into what they mean for an operator.
// Whether the numbers are "bad" is judged by the server (incidents, see lib/incidents.ts); this file only summarizes values.
import type { Sample } from "../types/model";
import type { Key } from "./i18n";
import { percentile } from "./hist";

const CURRENT_WINDOW = 5; // seconds used for the current value (median of p99, so a momentary spike does not flip it)

export type Level = "ok" | "caution" | "warning";

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const p99s = (samples: Sample[]) =>
  samples.map((s) => percentile(s.slots, 0.99)).filter((v): v is number => v != null);

// Current value: median p99 of the last few seconds
export function current(samples: Sample[]) {
  return { p99: median(p99s(samples.slice(-CURRENT_WINDOW))) };
}

// Rough normal level: median p99 of the seconds in view that were below the caution threshold (µs, from /api/triggers)
export function baseline(samples: Sample[], cautionUs: number) {
  return median(p99s(samples).filter((v) => v < cautionUs));
}

// Translation keys for level labels (look them up with t())
export const LEVEL_KEY: Record<Level, Key> = { ok: "level.ok", caution: "level.caution", warning: "level.warning" };
export const LEVEL_ICON: Record<Level, string> = { ok: "●", caution: "▲", warning: "◆" };
export const LEVEL_COLOR: Record<Level, string> = {
  ok: "var(--status-good)",
  caution: "var(--status-warning)",
  warning: "var(--status-critical)",
};
