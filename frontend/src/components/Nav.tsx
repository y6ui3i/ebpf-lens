import { useEffect, useState } from "react";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_LABEL, type Level } from "../lib/lens";
import { Link, ROUTES } from "../lib/router";

// OpenSearch Dashboards 風のメニュー。上部バーの ☰ で左から滑り出し、もう一度押すと滑って消える。
// 閉じている間も DOM に残して transform で動かす(出入りのアニメーションのため)。閉じている間は inert にする

type Group = { title: string; items: { path?: string; label: string }[] };

const GROUPS: Group[] = [
  { title: "eBPFLens", items: [{ path: "/", label: "ダッシュボード" }] },
  {
    title: "リソース",
    items: [
      { path: "/cpu", label: "CPU実行待ち時間" },
      { path: "/processes", label: "プロセスの起動と終了" },
      { label: "メモリ" },
      { label: "ディスク" },
      { label: "ネットワーク" },
      { label: "GPU" },
    ],
  },
];

const RECENT_MAX = 3;

export function Nav({ path, open, onClose, levels }: {
  path: string;
  open: boolean;
  onClose: () => void;
  levels: Record<string, Level>; // 画面ごとの判定。異常がある画面だけアイコンを出す
}) {
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
    title: "最近見た画面",
    items: recent.map((p) => ({ path: p, label: ROUTES.find((r) => r.path === p)?.label ?? p })),
  };

  return (
    <>
      {/* 背景を少し暗くして、押すと閉じる */}
      <div
        aria-hidden
        onClick={onClose}
        className={`fixed inset-x-0 top-12 bottom-0 z-20 bg-black/30 transition-opacity duration-300 motion-reduce:transition-none ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <nav
        id="main-nav"
        aria-label="メニュー"
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
                <span>{g.title}</span>
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
                        <NavLink path={it.path} label={it.label} active={it.path === path} level={levels[it.path]} onNavigate={onClose} />
                      ) : (
                        <span className="flex items-center justify-between px-4 py-1.5 text-sm" style={{ color: "var(--text-muted)" }}>
                          {it.label}
                          <span className="text-xs">準備中</span>
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
        <span style={{ color: LEVEL_COLOR[level] }} title={LEVEL_LABEL[level]}>
          <span aria-hidden>{LEVEL_ICON[level]}</span>
          <span className="sr-only">{LEVEL_LABEL[level]}</span>
        </span>
      )}
    </Link>
  );
}

// 最近見た画面(今の画面は除く)。ブラウザごとの便利機能なので、保存できなくても動くようにする
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
        // 保存できない環境では、このセッションの間だけ覚える
      }
      return next;
    });
  }, [path]);
  return recent.filter((p) => p !== path && ROUTES.some((r) => r.path === p)).slice(0, RECENT_MAX);
}

export function MenuButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-label={open ? "メニューを閉じる" : "メニューを開く"}
      aria-expanded={open}
      aria-controls="main-nav"
      className="flex h-12 w-12 items-center justify-center text-lg hover:bg-[var(--page)]"
      style={{ borderRight: "1px solid var(--border)" }}
    >
      ☰
    </button>
  );
}
