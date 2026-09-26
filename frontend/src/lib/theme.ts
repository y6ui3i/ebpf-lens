import { useEffect, useState } from "react";

// canvas や uPlot は CSS 変数を直接使えないので、描画時に値を読む
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// OS のライト/ダーク切り替えで再描画するためのキー
export function useColorSchemeKey(): string {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const [dark, setDark] = useState(mq.matches);
  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [mq]);
  return dark ? "dark" : "light";
}
