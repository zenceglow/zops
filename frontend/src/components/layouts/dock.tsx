import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LogOut } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { NavLangIcon, NavUserIcon } from '../icons/nav-icons';
import { SIDEBAR_GROUPS } from '../../router/sider-menu';
import { isParent, pathMatches, type SidebarItem } from '../../lib/sidebar-config';
import useUserStore from '../../stores/user.store';
import useAuthorizeStore from '../../stores/authorize.store';
import { useThemeStore } from '../../stores/theme-store';
import { nextTheme, themeIcon, themeLabelKey } from '../../stores/theme-prefs';
import { cn } from '../../lib/utils';

/**
 * 桌面式常驻 Dock，取代左侧栏。
 *
 * 侧栏是"后台管理系统"的形状：它先把产品定性成一张表，再让内容去填。
 * 这台机器的定位是"服务器桌面"，所以导航做成贴底的浮动 Dock —— 图标为主、
 * 悬停才出名字，页面中间整块留给内容本身。
 *
 * 条目直接复用 SIDEBAR_GROUPS，避免两处导航配置各写一遍、迟早走歪。
 */
const TOP_ITEMS: SidebarItem[] = SIDEBAR_GROUPS.flatMap((g) => g.items);

function dockClass(active?: boolean) {
  return cn(
    'group relative flex size-11 items-center justify-center rounded-xl text-muted-foreground',
    'transition-all duration-150 hover:-translate-y-0.5 hover:bg-muted hover:text-foreground',
    active && 'bg-muted text-foreground',
  );
}

/** 图标 + 悬停浮出的名字 + 当前页小圆点。 */
function DockGlyph({
  label,
  active,
  children,
}: {
  label: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      {children}
      <span
        className={cn(
          'pointer-events-none absolute -top-9 z-10 whitespace-nowrap rounded-lg border bg-popover px-2 py-1',
          'text-xs text-popover-foreground opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100',
        )}
      >
        {label}
      </span>
      {active && <span className="absolute -bottom-1 size-1 rounded-full bg-primary" />}
    </>
  );
}

function DockAction({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className={dockClass(active)}>
      <DockGlyph label={label} active={active}>
        {children}
      </DockGlyph>
    </button>
  );
}

export function Dock() {
  const { t, i18n } = useTranslation();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const hasPermission = useUserStore((s) => s.hasPermission);
  const user = useUserStore((s) => s.user);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const ThemeIcon = themeIcon(theme);

  const visible = TOP_ITEMS.filter((i) => hasPermission(i.perm));
  if (visible.length === 0) return null;

  const logout = () => {
    useAuthorizeStore.getState().logout();
    useUserStore.getState().clear();
    navigate('/login', { replace: true });
  };

  const toggleLang = () => {
    const next = i18n.language === 'zh' ? 'en' : 'zh';
    i18n.changeLanguage(next);
    localStorage.setItem('ops-lang', next);
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
      <nav
        aria-label={t('app.name')}
        className={cn(
          'pointer-events-auto flex items-center gap-1 rounded-2xl border border-border/70 p-2',
          // 85% 而不是 70%：内容滚到 Dock 后面时，70% 的透出会跟浮起来的图标
          // 抢注意力，看着像没对齐而不是"浮在上面"。
          'bg-background/85 shadow-lg shadow-black/20 backdrop-blur-xl',
        )}
      >
        {visible.map((item) => {
          const Icon = item.icon;

          if (isParent(item)) {
            const active = item.children.some((c) => pathMatches(pathname, c.path));
            return (
              <DropdownMenu key={item.labelKey}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t(item.labelKey)}
                    className={dockClass(active)}
                  >
                    <DockGlyph label={t(item.labelKey)} active={active}>
                      <Icon />
                    </DockGlyph>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="center" className="mb-3">
                  {item.children
                    .filter((c) => hasPermission(c.perm))
                    .map((c) => {
                      const ChildIcon = c.icon;
                      return (
                        <DropdownMenuItem key={c.path} asChild>
                          <NavLink to={c.path} className="gap-2">
                            <ChildIcon />
                            <span>{t(c.labelKey)}</span>
                          </NavLink>
                        </DropdownMenuItem>
                      );
                    })}
                </DropdownMenuContent>
              </DropdownMenu>
            );
          }

          const active = pathMatches(pathname, item.path);
          return (
            <NavLink
              key={item.path}
              to={item.path}
              aria-label={t(item.labelKey)}
              className={dockClass(active)}
            >
              <DockGlyph label={t(item.labelKey)} active={active}>
                <Icon />
              </DockGlyph>
            </NavLink>
          );
        })}

        <span className="mx-1 h-8 w-px shrink-0 bg-border" />

        <DockAction label={t('nav.switch_lang')} onClick={toggleLang}>
          <NavLangIcon />
        </DockAction>
        <DockAction label={t(themeLabelKey(theme))} onClick={() => setTheme(nextTheme(theme))}>
          <ThemeIcon />
        </DockAction>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={user?.username || 'Admin'} className={dockClass()}>
              <DockGlyph label={user?.username || 'Admin'}>
                <NavUserIcon />
              </DockGlyph>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className="mb-3 min-w-40">
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span>{user?.username || 'Admin'}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {user?.role === 'super_admin' ? t('members.role_super') : t('members.role_member')}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={logout} className="gap-2 text-destructive">
              <LogOut className="size-4" />
              <span>{t('nav.logout')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
    </div>
  );
}
