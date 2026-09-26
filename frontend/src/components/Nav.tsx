import { useEffect, useState } from "react";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_KEY, type Level } from "../lib/lens";
import { Link, ROUTES } from "../lib/router";
import { useI18n, type Key } from "../lib/i18n";

// OpenSearch Dashboards style menu. The ☰ in the top bar slides it in from the left; pressing again slides it out.
// It stays in the DOM while closed and moves with transform (for the enter/leave animation). It is inert while closed

type Group = { title: Key; items: { path?: string; label: Key }[] };

const GROUPS: Group[] = [
  {
    title: "nav.group.ebpflens",
    items: [
      { path: "/", label: "page.dashboard" },
      { path: "/all", label: "page.all" },
    ],
  },
  {
    title: "nav.group.resources",
    items: [
      { path: "/cpu", label: "page.cpu" },
      { path: "/processes", label: "page.processes" },
      { path: "/memory", label: "page.memory" },
      { label: "resource.disk" },
      { label: "resource.network" },
      { label: "resource.gpu" },
    ],
  },
];

const RECENT_MAX = 3;

export function Nav({ path, open, onClose, levels }: {
  path: string;
  open: boolean;
  onClose: () => void;
  levels: Record<string, Level>; // status per screen; only screens with a problem get an icon
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
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
      const r = ROUTES.find((x) => x.path === p);
      return r ? [{ path: p, label: r.labelKey }] : [];
    }),
  };

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
        {[recentGroup, ...GROUPS].map((g) =>
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
                  {g.items.map((it) => (
                    <li key={`${g.title}:${it.label}`}>
                      {it.path ? (
                        <NavLink path={it.path} label={t(it.label)} active={it.path === path} level={levels[it.path]} onNavigate={onClose} />
                      ) : (
                        <span className="flex items-center justify-between px-4 py-1.5 text-sm" style={{ color: "var(--text-muted)" }}>
                          {t(it.label)}
                          <span className="text-xs">{t("nav.soon")}</span>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ),
        )}
      </nav>
    </>
  );
}

function NavLink({ path, label, active, level, onNavigate }: {
  path: string; label: string; active: boolean; level?: Level; onNavigate: () => void;
}) {
  const { t } = useI18n();
  return (
    <Link
      to={path}
      onNavigate={onNavigate}
      aria-current={active ? "page" : undefined}
      className="flex items-center justify-between gap-2 px-4 py-1.5 text-sm hover:bg-[var(--page)]"
      style={{
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        fontWeight: active ? 600 : 400,
        boxShadow: active ? "inset 3px 0 0 var(--series-1)" : undefined,
      }}
    >
      <span>{label}</span>
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
  return recent.filter((p) => p !== path && ROUTES.some((r) => r.path === p)).slice(0, RECENT_MAX);
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
