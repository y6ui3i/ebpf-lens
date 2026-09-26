// log2 ヒストグラムの扱い。slot i は [2^i, 2^(i+1))、slot 0 のみ [0, 2)。

export function slotRange(i: number): [number, number] {
  return i === 0 ? [0, 2] : [2 ** i, 2 ** (i + 1)];
}

export function total(slots: number[]): number {
  return slots.reduce((a, b) => a + b, 0);
}

// 分位点の推定値。該当スロット内は線形補間する(ヒストグラムからの推定なので最大で 2 倍ずれうる)
export function percentile(slots: number[], q: number): number | null {
  const n = total(slots);
  if (n === 0) return null;
  const target = q * n;
  let cum = 0;
  for (let i = 0; i < slots.length; i++) {
    const c = slots[i];
    if (c > 0 && cum + c >= target) {
      const [lo, hi] = slotRange(i);
      return Math.max(1, lo + ((hi - lo) * (target - cum)) / c);
    }
    cum += c;
  }
  return slotRange(slots.length - 1)[1];
}

export function formatUs(us: number | null | undefined): string {
  if (us == null) return "–";
  if (us < 1000) return `${Math.round(us)} µs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(us < 10_000 ? 1 : 0)} ms`;
  return `${(us / 1_000_000).toFixed(1)} s`;
}

export function formatRange(i: number): string {
  const [lo, hi] = slotRange(i);
  return `${formatUs(lo)} 〜 ${formatUs(hi)}`;
}
