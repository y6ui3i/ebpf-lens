// Turns runqlat numbers into what they mean for an operator.
// The judgement is still a provisional frontend implementation, scaffolding until it moves to server-side triggers.
import type { Sample } from "../types/model";
import type { Key } from "./i18n";
import { percentile } from "./hist";

// Thresholds (provisional). Measured on hal: the 1-second p99 is about 30µs normally, at most 476µs even during GPU inference (Demucs),
// and 16ms under 4x overload with stress-ng. Chosen to be well away from both normal and overloaded values
export const CAUTION_US = 1_000;
export const WARNING_US = 10_000;

// Settings that keep a momentary spike from flipping the status
const CURRENT_WINDOW = 5; // seconds used for the current status (median of p99)
const MIN_EPISODE_SECONDS = 3; // excursions shorter than this are not reported as episodes
const MAX_GAP_SECONDS = 2; // gaps up to this many seconds count as the same episode

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

// Current status, judged from the median p99 of the last few seconds
export function current(samples: Sample[]) {
  const p99 = median(p99s(samples.slice(-CURRENT_WINDOW)));
  return { p99, level: levelOf(p99) };
}

// Rough normal level: median p99 of the seconds in view that were below the threshold
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

// Finds ranges where p99 exceeded the caution threshold. Returned newest first
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
        // warning if above the warning threshold for 3 s or more, otherwise caution
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

// Translation keys for level labels (look them up with t())
export const LEVEL_KEY: Record<Level, Key> = { ok: "level.ok", caution: "level.caution", warning: "level.warning" };
export const LEVEL_ICON: Record<Level, string> = { ok: "●", caution: "▲", warning: "◆" };
export const LEVEL_COLOR: Record<Level, string> = {
  ok: "var(--status-good)",
  caution: "var(--status-warning)",
  warning: "var(--status-critical)",
};
