import { useEffect, useState } from "react";

// canvas and uPlot cannot use CSS variables directly, so read the values at draw time
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Key used to redraw when the OS switches between light and dark
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
