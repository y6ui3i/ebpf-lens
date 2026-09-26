import { useEffect } from "react";
import { LEVEL_COLOR, LEVEL_ICON, LEVEL_LABEL, type Level } from "../lib/lens";
import { Link, ROUTES } from "../lib/router";

export const WIDE = "(min-width: 1024px)";

// 広い画面では左に常設するサイドメニュー、狭い画面では ☰ で開くドロワー。
// 出し分けは CSS のブレークポイント(lg)で行い、open は狭い画面のドロワーの開閉だけを表す
export function Nav({ path, open, onClose, levels }: {
  path: string;
  open: boolean;
  onClose: () => void;
  levels: Record<string, Level>; // 画面ごとの判定。異常がある画面だけアイコンを出す
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // 広い画面に広げたらドロワーの状態は捨てる(常設メニューに切り替わる)
    const mq = window.matchMedia(WIDE);
    const onWide = (e: MediaQueryListEvent) => e.matches && onClose();
    window.addEventListener("keydown", onKey);
    mq.addEventListener("change", onWide);
    return () => {
      window.removeEventListener("keydown", onKey);
      mq.removeEventListener("change", onWide);
    };
  }, [open, onClose]);

  return (
    <>
      {/* 狭い画面では背景を暗くして、押すと閉じる */}
      {open && <div className="fixed inset-0 z-20 bg-black/40 lg:hidden" onClick={onClose} aria-hidden />}
      <nav
        id="main-nav"
        aria-label="画面"
        className={`${open ? "fixed" : "hidden"} inset-y-0 left-0 z-30 w-60 p-4 lg:sticky lg:top-0 lg:z-auto lg:block lg:h-screen lg:shrink-0`}
        style={{ background: "var(--surface-1)", borderRight: "1px solid var(--border)" }}
      >
        <div className="mb-6 px-2 text-lg font-semibold tracking-tight">eBPFLens</div>
        <ul className="space-y-1">
          {ROUTES.map((r) => {
            const active = r.path === path;
            const level = levels[r.path];
            return (
              <li key={r.path}>
                <Link
                  to={r.path}
                  onNavigate={onClose}
                  aria-current={active ? "page" : undefined}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm"
                  style={{
                    background: active ? "var(--page)" : "transparent",
                    color: active ? "var(--text-primary)" : "var(--text-secondary)",
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  <span>{r.label}</span>
                  {level && level !== "ok" && (
                    <span style={{ color: LEVEL_COLOR[level] }} title={LEVEL_LABEL[level]}>
                      <span aria-hidden>{LEVEL_ICON[level]}</span>
                      <span className="sr-only">{LEVEL_LABEL[level]}</span>
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}

export function MenuButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-label={open ? "メニューを閉じる" : "メニューを開く"}
      aria-expanded={open}
      aria-controls="main-nav"
      className="rounded-md px-2 py-1 text-lg leading-none lg:hidden"
      style={{ border: "1px solid var(--border)", background: "var(--surface-1)" }}
    >
      ☰
    </button>
  );
}
