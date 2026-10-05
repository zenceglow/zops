import { useLocation } from 'react-router-dom';
import { Dock } from './dock';
import { MenuBar } from './menu-bar';
import useAuthorizeStore from '../../stores/authorize.store';

/**
 * 应用外壳：没有侧栏、也没有页头 —— 只有一条贴底 Dock。
 *
 * header 上的 logo 是"网站的头部"，而这一页是桌面：身份由 Dock 承担，
 * 内容从最上面开始。留一条固定高度的页头只会让每页都白白少掉 60px。
 */
export function AppLayout({ children }: { children: React.ReactNode }) {
  const token = useAuthorizeStore((s) => s.token);
  const hasHydrated = useAuthorizeStore((s) => s._hasHydrated);
  const { pathname } = useLocation();

  if (!hasHydrated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!token || pathname === '/login' || pathname.startsWith('/setup')) {
    return <>{children}</>;
  }

  return (
    <div className="relative min-h-screen bg-background">
            {/* pt-11：给顶部 28px 的菜单栏让位，再留一点呼吸。 */}
      <main className="mx-auto w-full max-w-6xl px-5 pb-32 pt-11 sm:px-8">{children}</main>
      <MenuBar />
      <Dock />
    </div>
  );
}
