import { NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { NavAgentIcon, NavLangIcon, NavSettingsIcon, NavUserIcon } from '../icons/nav-icons';
import { SIDEBAR_GROUPS } from '../../router/sider-menu';
import { isParent, pathMatches } from '../../lib/sidebar-config';
import { Perm } from '../../lib/permissions';
import { SettingsMenu } from './settings-menu';
import useUserStore from '../../stores/user.store';
import { useThemeStore } from '../../stores/theme-store';
import { nextTheme, themeIcon, themeLabelKey } from '../../stores/theme-prefs';
import { cn } from '../../lib/utils';

/**
 * 桌面式常驻 Dock，取代左侧栏。
 *
 * 侧栏是"后台管理系统"的形状：它先把产品定性成一张表，再让内容去填。
 * 这台机器的定位是"服务器桌面"，所以导航做成贴底的浮动 Dock —— 页面中间整块
 * 留给内容本身。
 *
 * **2026-10 起改成图标上、标签下常显。** 原来是图标为主、悬停才浮出名字，问题是
 * 这台机器上超过一半的格子是"图标近义"的（大屏/统计、站点/网关、Docker/容器、
 * 文件/日志），光看图标分不出来，每次都要悬停等一下才知道点的是哪个 —— 那是把
 * 辨识成本推给了每一次点击。改成一格 64px 的竖排格子后整条 Dock 约 1210px，
 * 1280 的屏放得下；再窄就靠 flex 收缩 + 标签截断兜底，不会横向溢出。
 *
 * 条目的**定义**（标签、图标、权限）仍取自 SIDEBAR_GROUPS，一处维护；但**摆哪几
 * 个、什么顺序**由下面这张表说了算 —— 那套配置是"路由与权限的登记表"，里面有些
 * 页面（定时任务、系统子页）不该占 Dock 的位置。两者本来就不是一回事。
 */
const DOCK_ORDER = [
  '/monitor',
  '/screen',
  '/analytics',
  '/sites',
  '/deploy',
  '/market',
  '/network',
  '/ssh',
  '/files',
  '/logs',
  '/notify',
  '/security',
];

const ALL_LEAVES = SIDEBAR_GROUPS.flatMap((g) =>
  g.items.flatMap((i) => (isParent(i) ? i.children : [i])),
);
const byPath = (path: string) => ALL_LEAVES.find((i) => i.path === path);

/** Dock 上按固定顺序排的项目。Docker、成员不占这一条；接入 Codex 放在分隔线后。 */
function dockItems() {
  return DOCK_ORDER.map(byPath).filter((i): i is NonNullable<typeof i> => !!i);
}

function dockClass(active?: boolean) {
  return cn(
    // h-14 w-16 = 图标 20px + 间距 + 11px 标签，正好一格。px-0.5 而不是 px-1：
    // 最长的标签是「应用与服务」「事件与通知」（5 个汉字 ≈ 55px），格子内宽 60px
    // 刚够，再收 4px 就会截尾。min-w-0 + shrink 是给窄屏留的退路：横向放不下时
    // 整排一起缩、标签自己截断，而不是把 Dock 撑出屏幕。
    'flex h-14 w-16 min-w-0 shrink flex-col items-center justify-center gap-1 rounded-2xl px-0.5',
    'text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground',
    // 选中态用 foreground/10 而不是 muted：muted 在浅色下只比底色深一点点，
    // 压不住"当前在哪一页"。
    active && 'bg-foreground/10 text-foreground',
  );
}

/** 图标 + 常显的标签。标签截断时靠 title 兜底，不靠悬停浮层。 */
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
        title={label}
        className={cn(
          'w-full truncate text-center text-[11px] leading-none',
          active && 'font-medium',
        )}
      >
        {label}
      </span>
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
          // gap-0.5 + max-w：18 个控件在 1280 上排在 ~1210px，还剩一点余量；再窄
          // 就由 max-w 触发布局收缩，标签截断，而不是把 Dock 推出视口。
          'pointer-events-auto flex max-w-[calc(100vw-2rem)] items-center gap-0.5 rounded-[26px] border border-border/70 p-2',
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
          trigger={
            <button type="button" aria-label={t('settings.title')} className={dockClass(false)}>
              <DockGlyph label={t('settings.title')}>
                <NavSettingsIcon className="size-5" />
              </DockGlyph>
            </button>
          }
        />

        <span className="mx-0.5 h-9 w-px shrink-0 bg-border" />

        <DockAction label={t('nav.switch_lang')} onClick={toggleLang}>
          <NavLangIcon className="size-5" />
        </DockAction>
        <DockAction label={t(themeLabelKey(theme))} onClick={() => setTheme(nextTheme(theme))}>
          <ThemeIcon className="size-5" />
        </DockAction>

        {hasPermission(Perm.NAV_AGENT) && (
          <NavLink
            to="/agent"
            aria-label={t('nav.agent')}
            className={dockClass(pathMatches(pathname, '/agent'))}
          >
            <DockGlyph label={t('nav.agent')} active={pathMatches(pathname, '/agent')}>
              <NavAgentIcon className="size-5" />
            </DockGlyph>
          </NavLink>
        )}

        {/* 个人=进个人中心，不再弹菜单。退出登录放在那一页里 —— 它本来就该
            是"进来之后做的事"，而不是随时悬在头像上等着被误点。 */}
        <NavLink to="/profile" aria-label={user?.username || 'Admin'} className={dockClass(pathname === '/profile')}>
          <DockGlyph label={user?.username || 'Admin'} active={pathname === '/profile'}>
            <NavUserIcon className="size-5" />
          </DockGlyph>
        </NavLink>
      </nav>
    </div>
  );
}
