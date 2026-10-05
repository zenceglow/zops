import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { BrandLogo } from '../brand-logo';
import { SIDEBAR_GROUPS } from '../../router/sider-menu';
import { isParent, pathMatches } from '../../lib/sidebar-config';
import useUserStore from '../../stores/user.store';

/**
 * 顶部细菜单栏（macOS 那种）。
 *
 * 只放"随时想瞄一眼"的东西：这是哪个面板、现在在哪一页、几点、谁登录着。
 * 刻意不承担导航 —— 导航在底部 Dock，那是"桌面"的语义；这一条是系统的状态栏。
 * 高度 28px，macOS 的菜单栏是 24px 上下，再厚就不像状态栏而像页头了。
 */

/** 分钟级的时间显示，30 秒对一次表就够，没必要每秒重渲染整条栏。 */
function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** 当前路径对应的栏目名。配置直接复用导航那份，别两处各写一份中文。 */
function useSectionLabel() {
  const { pathname } = useLocation();
  const { t } = useTranslation();
  for (const group of SIDEBAR_GROUPS) {
    for (const item of group.items) {
      if (isParent(item)) {
        const child = item.children.find((c) => pathMatches(pathname, c.path));
        if (child) return t(child.labelKey);
      } else if (pathMatches(pathname, item.path)) {
        return t(item.labelKey);
      }
    }
  }
  return '';
}

export function MenuBar() {
  const user = useUserStore((s) => s.user);
  const now = useClock();
  const section = useSectionLabel();

  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  return (
    <div
      className={
        'fixed inset-x-0 top-0 z-30 flex h-7 items-center gap-2 border-b border-border/50 ' +
        'bg-background/70 px-3 text-[11px] backdrop-blur-xl'
      }
    >
      <BrandLogo className="size-4" />
      {/* 品牌名不跟随语言切换：它是标识，不是文案。 */}
      <span className="font-semibold tracking-wide">ZOPS</span>
      {section && (
        <>
          <span className="text-muted-foreground/40">|</span>
          <span className="truncate text-muted-foreground">{section}</span>
        </>
      )}

      <div className="ml-auto flex items-center gap-3 text-muted-foreground">
        <span className="tabular-nums">{time}</span>
        {user?.username && <span className="max-w-32 truncate">{user.username}</span>}
      </div>
    </div>
  );
}
