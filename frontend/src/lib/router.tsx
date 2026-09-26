// There are only a few screens, so switch them with the History API alone instead of adding a dependency.
// The server falls back to index.html for unknown paths, so opening /cpu etc. directly works.
import { useSyncExternalStore, type AnchorHTMLAttributes } from "react";
import type { Key } from "./i18n";

export type Route = { path: string; labelKey: Key };

export const ROUTES: Route[] = [
  { path: "/", labelKey: "page.dashboard" },
  { path: "/all", labelKey: "page.all" },
  { path: "/cpu", labelKey: "page.cpu" },
  { path: "/processes", labelKey: "page.processes" },
  { path: "/memory", labelKey: "page.memory" },
];

const subscribe = (cb: () => void) => {
  window.addEventListener("popstate", cb);
  return () => window.removeEventListener("popstate", cb);
};

export function usePath(): string {
  const path = useSyncExternalStore(subscribe, () => window.location.pathname);
  return ROUTES.some((r) => r.path === path) ? path : "/";
}

export function navigate(to: string) {
  if (to === window.location.pathname) return;
  window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; onNavigate?: () => void };

// Intercept plain clicks only (let Cmd/Ctrl-click through so it can open a new tab)
export function Link({ to, onNavigate, onClick, ...rest }: LinkProps) {
  return (
    <a
      href={to}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
        onNavigate?.();
      }}
      {...rest}
    />
  );
}
