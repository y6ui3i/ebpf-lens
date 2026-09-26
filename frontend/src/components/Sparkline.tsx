// 升目に入れる小さな推移。軸は持たず、形だけを見せる(値は升目の数字で読む)
export function Sparkline({ values, log = false, label }: { values: (number | null)[]; log?: boolean; label: string }) {
  const W = 100;
  const H = 24;
  const f = (v: number) => (log ? Math.log10(Math.max(v, 1)) : v);
  const ys = values.map((v) => (v == null ? null : f(v)));
  const known = ys.filter((v): v is number => v != null);
  if (known.length < 2) return <div style={{ height: H }} aria-hidden />;

  const min = 0;
  const max = Math.max(...known, log ? 5 : 1e-9); // log のときは 100ms(10^5 µs)を上端の最低値にする
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => H - 1 - ((v - min) / (max - min || 1)) * (H - 2);

  let d = "";
  let pen = false;
  ys.forEach((v, i) => {
    if (v == null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(2)},${y(v).toFixed(2)}`;
    pen = true;
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full" style={{ height: H }} role="img" aria-label={label}>
      <title>{label}</title>
      <path d={d} fill="none" stroke="var(--series-1)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
