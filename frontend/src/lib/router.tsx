// There are only a few screens, so switch them with the History API alone instead of adding a dependency.
// The server falls back to index.html for unknown paths, so opening /cpu etc. directly works.
import { useSyncExternalStore, type AnchorHTMLAttributes } from "react";
import type { Key } from "./i18n";

export type Route = { path: string; labelKey: Key };

// Static screens. Dynamic ones (one page per VM) are matched by DYNAMIC below
export const ROUTES: Route[] = [
  { path: "/", labelKey: "page.dashboard" },
  { path: "/all", labelKey: "page.all" },
  { path: "/vms", labelKey: "page.vms" },
  { path: "/cpu", labelKey: "page.cpu" },
  { path: "/processes", labelKey: "page.processes" },
  { path: "/memory", labelKey: "page.memory" },
  { path: "/disk", labelKey: "page.disk" },
  { path: "/gpu", labelKey: "page.gpu" },
];

// Pattern routes: `route` is the template the app switches on, `params` carries the decoded segments
const DYNAMIC: { route: string; labelKey: Key; re: RegExp; names: string[] }[] = [
  { route: "/vms/:name", labelKey: "page.vm", re: /^\/vms\/([^/]+)$/, names: ["name"] },
];

export type Match = { route: string; labelKey: Key; params: Record<string, string> };

// Which screen a path belongs to (null for unknown paths). Segments are URL-decoded, so VM names may contain any character
export function matchRoute(path: string): Match | null {
  const r = ROUTES.find((x) => x.path === path);
  if (r) return { route: r.path, labelKey: r.labelKey, params: {} };
  for (const d of DYNAMIC) {
    const m = d.re.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    d.names.forEach((n, i) => {
      try {
        params[n] = decodeURIComponent(m[i + 1]);
      } catch {
        params[n] = m[i + 1]; // malformed escape: keep the raw segment rather than fail the whole page
      }
    });
    return { route: d.route, labelKey: d.labelKey, params };
  }
  return null;
}

export const vmPath = (name: string) => `/vms/${encodeURIComponent(name)}`;

const subscribe = (cb: () => void) => {
  window.addEventListener("popstate", cb);
  return () => window.removeEventListener("popstate", cb);
};

// The real path for known screens (including /vms/<name>); "/" for anything else
export function usePath(): string {
  const path = useSyncExternalStore(subscribe, () => window.location.pathname);
  return matchRoute(path) ? path : "/";
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
