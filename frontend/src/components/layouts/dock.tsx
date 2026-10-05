import { NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { NavFirewallIcon, NavLangIcon, NavSettingsIcon, NavUserIcon } from '../icons/nav-icons';
import { SIDEBAR_GROUPS } from '../../router/sider-menu';
import { isParent, pathMatches, type SidebarItem } from '../../lib/sidebar-config';
import { Perm } from '../../lib/permissions';
import { SettingsDialogs } from './settings-dialogs';
import { SettingsMenu, type SettingsDialog } from './settings-menu';
import { useState } from 'react';
import useUserStore from '../../stores/user.store';
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
 * 条目的**定义**（标签、图标、权限）仍取自 SIDEBAR_GROUPS，一处维护；但**摆哪几
 * 个、什么顺序**由下面这张表说了算 —— 那套配置是"路由与权限的登记表"，里面有些
 * 页面（定时任务、系统子页）不该占 Dock 的位置。两者本来就不是一回事。
 */
const DOCK_ORDER = [
  '/monitor',
  '/ssh',
  '/files',
  '/logs',
  '/agent',
  '/sites',
  '/docker',
  '/members',
];

const ALL_ITEMS: SidebarItem[] = SIDEBAR_GROUPS.flatMap((g) => g.items);
const byPath = (path: string) =>
  ALL_ITEMS.find((i) =>
    isParent(i) ? i.children.some((c) => c.path === path) : i.path === path,
  );

/** Dock 上按固定顺序排的项目；防火墙是单独拎出来的顶层入口。 */
function dockItems(): SidebarItem[] {
  const ordered = DOCK_ORDER.map(byPath).filter((i): i is SidebarItem => !!i);
  // 防火墙原来在"系统"子菜单里，现在直接上 Dock —— 它是会被频繁点开的东西。
  const firewall = ALL_ITEMS.flatMap((i) => (isParent(i) ? i.children : [i])).find(
    (c) => c.path === '/system/firewall',
  );
  return firewall ? [...ordered, firewall] : ordered;
}

function dockClass(active?: boolean) {
  return cn(
    'group relative flex size-12 items-center justify-center rounded-2xl text-muted-foreground',
    'transition-all duration-150 hover:-translate-y-0.5 hover:bg-accent hover:text-foreground',
    // 选中态用 foreground/10 而不是 muted：muted 在浅色下只比底色深一点点，
    // 配上实心图标才压得住，否则"当前在哪一页"要靠那个小圆点才看得出来。
    active && 'bg-foreground/10 text-foreground',
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
  const hasPermission = useUserStore((s) => s.hasPermission);
  const user = useUserStore((s) => s.user);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const ThemeIcon = themeIcon(theme);
  const [dialog, setDialog] = useState<SettingsDialog | null>(null);

  const visible = dockItems().filter((i) => hasPermission(i.perm));
  if (visible.length === 0) return null;

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
          'pointer-events-auto flex items-center gap-1 rounded-[26px] border border-border/70 p-2',
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
                      <Icon className="size-5" />
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
                <Icon className="size-5" />
              </DockGlyph>
            </NavLink>
          );
        })}

        <SettingsMenu
          navSystem={hasPermission(Perm.NAV_SYSTEM)}
          onDialog={setDialog}
          trigger={
            <button type="button" aria-label={t('settings.title')} className={dockClass(false)}>
              <DockGlyph label={t('settings.title')}>
                <NavSettingsIcon className="size-5" />
              </DockGlyph>
            </button>
          }
        />

        <span className="mx-1 h-8 w-px shrink-0 bg-border" />

        <DockAction label={t('nav.switch_lang')} onClick={toggleLang}>
          <NavLangIcon className="size-5" />
        </DockAction>
        <DockAction label={t(themeLabelKey(theme))} onClick={() => setTheme(nextTheme(theme))}>
          <ThemeIcon className="size-5" />
        </DockAction>

        {/* 个人=进个人中心，不再弹菜单。退出登录放在那一页里 —— 它本来就该
            是"进来之后做的事"，而不是随时悬在头像上等着被误点。 */}
        <NavLink to="/profile" aria-label={user?.username || 'Admin'} className={dockClass(pathname === '/profile')}>
          <DockGlyph label={user?.username || 'Admin'} active={pathname === '/profile'}>
            <NavUserIcon className="size-5" />
          </DockGlyph>
        </NavLink>
      </nav>

      <SettingsDialogs open={dialog} onOpenChange={setDialog} />
    </div>
  );
}
