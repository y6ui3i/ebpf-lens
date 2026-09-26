// 画面数が少ないので、依存を増やさず History API だけで切り替える。
// サーバーは存在しないパスを index.html に回すので、/cpu などを直接開いても動く。
import { useSyncExternalStore, type AnchorHTMLAttributes } from "react";

export type Route = { path: string; label: string };

export const ROUTES: Route[] = [
  { path: "/", label: "ダッシュボード" },
  { path: "/all", label: "すべてのパネル" },
  { path: "/cpu", label: "CPU実行待ち時間" },
  { path: "/processes", label: "プロセスの起動と終了" },
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

// 通常のクリックだけ横取りする(Cmd/Ctrl クリックは新しいタブで開けるように素通し)
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
