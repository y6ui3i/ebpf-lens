import { useEffect, useState } from "react";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_KEY, type Level } from "../lib/lens";
import { Link, ROUTES, matchRoute, vmPath } from "../lib/router";
import { useI18n, type Key, type TFn } from "../lib/i18n";
import type { VmPhase } from "../lib/vms";

// OpenSearch Dashboards style menu. The ☰ in the top bar slides it in from the left; pressing again slides it out.
// It stays in the DOM while closed and moves with transform (for the enter/leave animation). It is inert while closed

// A menu entry: `label` is a translation key for static screens; `text` is a literal (a VM name) for dynamic ones
type Item = { path?: string; label?: Key; text?: string; state?: "running" | "stopped"; level?: Level; indent?: boolean };
type Group = { title: Key; items: Item[] };

// The VMs the menu lists, as computed in App (running now, or with an incident in the last 24 h)
export type NavVm = { name: string; running: boolean; level: Level; phase: VmPhase };

const STATIC_GROUPS: Group[] = [
  {
    title: "nav.group.ebpflens",
    items: [
      { path: "/", label: "page.dashboard" },
      { path: "/all", label: "page.all" },
      { path: "/history", label: "page.history" },
      { path: "/settings", label: "page.settings" },
    ],
  },
  {
    title: "nav.group.host",
    items: [
      { path: "/cpu", label: "page.cpu" },
      { path: "/processes", label: "page.processes" },
      { path: "/memory", label: "page.memory" },
      { path: "/disk", label: "page.disk" },
      { path: "/network", label: "page.network" },
      { path: "/dns", label: "page.dns" },
      { path: "/files", label: "page.files" },
      { path: "/gpu", label: "page.gpu" },
    ],
  },
];

const RECENT_MAX = 3;
const STOPPED_FOLD = "\u0000stopped"; // marker item rendered as the "Stopped (N)" fold

// Menu text for a path: the screen name, or the VM name for /vms/<name>
function labelFor(path: string, t: TFn): string | undefined {
  const m = matchRoute(path);
  if (!m) return undefined;
  return m.route === "/vms/:name" ? m.params.name : t(m.labelKey);
}

export function Nav({ path, open, onClose, levels, vms }: {
  path: string;
  open: boolean;
  onClose: () => void;
  levels: Record<string, Level>; // status per screen; only screens with a problem get an icon
  vms: NavVm[];
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [stoppedOpen, setStoppedOpen] = useState(false); // the "Stopped (N)" fold under the VM group, closed by default
  const recent = useRecent(path);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const toggle = (title: string) => setCollapsed((c) => ({ ...c, [title]: !c[title] }));
  const recentGroup: Group = {
    title: "nav.group.recent",
    items: recent.flatMap((p) => {
      const text = labelFor(p, t);
      return text ? [{ path: p, text }] : [];
    }),
  };
  // VMs get their own group between "eBPFLens" and "Host": the list, then the VMs that are running or need attention,
  // then the recently stopped ones folded under "Stopped (N)". VMs stopped longer ago are in the list only (see lib/vms LIFECYCLE)
  const entry = (v: NavVm, indent = false): Item => ({ path: vmPath(v.name), text: v.name, state: v.running ? "running" : "stopped", level: v.level, indent });
  const shown = vms.filter((v) => v.phase === "running" || v.phase === "attention");
  const stopped = vms.filter((v) => v.phase === "stopped");
  const vmGroup: Group = {
    title: "nav.group.vms",
    items: [
      { path: "/vms", label: "page.vms" },
      ...shown.map((v) => entry(v)),
      ...(stopped.length > 0 ? [{ text: STOPPED_FOLD } as Item] : []),
      ...(stoppedOpen ? stopped.map((v) => entry(v, true)) : []),
    ],
  };
  const groups = [recentGroup, STATIC_GROUPS[0], vmGroup, ...STATIC_GROUPS.slice(1)];

  return (
    <>
      {/* Dim the background slightly; clicking it closes the menu */}
      <div
        aria-hidden
        onClick={onClose}
        className={`fixed inset-x-0 top-12 bottom-0 z-20 bg-black/30 transition-opacity duration-300 motion-reduce:transition-none ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <nav
        id="main-nav"
        aria-label={t("nav.aria")}
        inert={!open}
        className={`fixed top-12 bottom-0 left-0 z-30 w-72 max-w-[85vw] overflow-y-auto shadow-xl transition-transform duration-300 ease-out motion-reduce:transition-none ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ background: "var(--surface-1)", borderRight: "1px solid var(--border)" }}
      >
        {groups.map((g) =>
          g.items.length === 0 ? null : (
            <section key={g.title} style={{ borderBottom: "1px solid var(--border)" }}>
              <button
                onClick={() => toggle(g.title)}
                aria-expanded={!collapsed[g.title]}
                className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold"
              >
                <span>{t(g.title)}</span>
                <span
                  aria-hidden
                  className={`text-xs transition-transform duration-200 motion-reduce:transition-none ${collapsed[g.title] ? "-rotate-90" : ""}`}
                  style={{ color: "var(--text-muted)" }}
                >
                  ⌄
                </span>
              </button>
              {!collapsed[g.title] && (
                <ul className="pb-2">
                  {g.items.map((it) => {
                    const text = it.text ?? (it.label ? t(it.label) : "");
                    return (
                      <li key={`${g.title}:${it.path ?? it.label ?? it.text}`}>
                        {it.text === STOPPED_FOLD ? (
                          <button
                            onClick={() => setStoppedOpen((v) => !v)}
                            aria-expanded={stoppedOpen}
                            className="flex w-full items-center justify-between px-4 py-1.5 text-sm hover:bg-[var(--page)]"
                            style={{ color: "var(--text-secondary)" }}
                          >
                            <span>{t("nav.stopped", { n: stopped.length })}</span>
                            <span aria-hidden className={`text-xs transition-transform duration-200 motion-reduce:transition-none ${stoppedOpen ? "" : "-rotate-90"}`} style={{ color: "var(--text-muted)" }}>⌄</span>
                          </button>
                        ) : it.path ? (
                          <NavLink
                            path={it.path} label={text} active={it.path === path}
                            level={it.level ?? levels[it.path]} state={it.state} indent={it.indent} onNavigate={onClose}
                          />
                        ) : (
                          <span className="flex items-center justify-between px-4 py-1.5 text-sm" style={{ color: "var(--text-muted)" }}>
                            {text}
                            <span className="text-xs">{t("nav.soon")}</span>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ),
        )}
      </nav>
    </>
  );
}

function NavLink({ path, label, active, level, state, indent, onNavigate }: {
  path: string; label: string; active: boolean; level?: Level; state?: "running" | "stopped"; indent?: boolean; onNavigate: () => void;
}) {
  const { t } = useI18n();
  const stateText = state ? t(state === "running" ? "vm.state.running" : "vm.state.stopped") : undefined;
  return (
    <Link
      to={path}
      onNavigate={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`flex items-center justify-between gap-2 py-1.5 pr-4 text-sm hover:bg-[var(--page)] ${indent ? "pl-8" : "pl-4"}`}
      style={{
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        fontWeight: active ? 600 : 400,
        boxShadow: active ? "inset 3px 0 0 var(--series-1)" : undefined,
      }}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {/* VM entries carry a state mark: filled = running, hollow = stopped (the tooltip and screen-reader text say which) */}
        {stateText && (
          <span title={stateText} className="shrink-0 text-[0.6rem]" style={{ color: state === "running" ? "var(--status-good)" : "var(--text-muted)" }}>
            <span aria-hidden>{state === "running" ? "●" : "○"}</span>
            <span className="sr-only">{stateText}</span>
          </span>
        )}
        <span className="truncate">{label}</span>
      </span>
      {level && level !== "ok" && (
        <span style={{ color: LEVEL_COLOR[level] }} title={t(LEVEL_KEY[level])}>
          <span aria-hidden>{LEVEL_ICON[level]}</span>
          <span className="sr-only">{t(LEVEL_KEY[level])}</span>
        </span>
      )}
    </Link>
  );
}

// Recently viewed screens (excluding the current one). A per-browser convenience, so it must work even when it cannot be saved
function useRecent(path: string): string[] {
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("ebpflens.recent") ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    setRecent((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, RECENT_MAX + 1);
      try {
        localStorage.setItem("ebpflens.recent", JSON.stringify(next));
      } catch {
        // Where saving is not possible, remember only for this session
      }
      return next;
    });
  }, [path]);
  return recent.filter((p) => p !== path && (ROUTES.some((r) => r.path === p) || matchRoute(p) != null)).slice(0, RECENT_MAX);
}

export function MenuButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return (
    <button
      onClick={onToggle}
      aria-label={t(open ? "nav.close" : "nav.open")}
      aria-expanded={open}
      aria-controls="main-nav"
      className="flex h-12 w-12 items-center justify-center text-lg hover:bg-[var(--page)]"
      style={{ borderRight: "1px solid var(--border)" }}
    >
      ☰
    </button>
  );
}
