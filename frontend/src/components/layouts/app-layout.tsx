import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BrandLogo } from '../brand-logo';
import { Dock } from './dock';
import useAuthorizeStore from '../../stores/authorize.store';

/**
 * 应用外壳：没有侧栏，只有左上角一枚小字标 + 贴底 Dock。
 *
 * 页面自己决定内容怎么排，外壳不套 padding 之外的任何"管理后台"结构。
 */
export function AppLayout({ children }: { children: React.ReactNode }) {
  const token = useAuthorizeStore((s) => s.token);
  const hasHydrated = useAuthorizeStore((s) => s._hasHydrated);
  const { pathname } = useLocation();
  const { t } = useTranslation();

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
      <header className="flex items-center gap-2 px-5 pt-6 sm:px-8">
        <BrandLogo className="size-6" />
        <span className="text-sm font-semibold tracking-tight">{t('app.name')}</span>
      </header>
      <main className="mx-auto w-full max-w-6xl px-5 pb-40 pt-4 sm:px-8">{children}</main>
      <Dock />
    </div>
  );
}
