import { useTranslation } from 'react-i18next';
import { PanelLeftOpenIcon, PanelLeftCloseIcon } from 'lucide-react';
import { NavLangIcon, NavUserIcon } from '../icons/nav-icons';
import { useThemeStore } from '../../stores/theme-store';
import { nextTheme, themeIcon, themeLabelKey } from '../../stores/theme-prefs';
import { useSidebar, SidebarMenu, SidebarMenuItem, SidebarMenuButton } from '../ui/sidebar';
import useUserStore from '../../stores/user.store';

export function SidebarActions() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const user = useUserStore((s) => s.user);
  const { t, i18n } = useTranslation();
  const { toggleSidebar, state } = useSidebar();
  const collapsed = state === 'collapsed';

  const toggleLang = () => {
    const next = i18n.language === 'zh' ? 'en' : 'zh';
    i18n.changeLanguage(next);
    localStorage.setItem('ops-lang', next);
  };

  const ThemeIcon = themeIcon(theme);
  const themeLabel = t(themeLabelKey(theme));
  const displayName = user?.username || 'Admin';

  return (
    <SidebarMenu>
      <SidebarMenuItem className='mb-2'>
        <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-accent">
            <NavUserIcon />
          </div>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">{displayName}</span>
            <span className="truncate text-xs text-sidebar-foreground/60">
              {user?.role === 'super_admin' ? t('members.role_super') : t('members.role_member')}
            </span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={toggleLang} tooltip={t('nav.switch_lang')}>
          <NavLangIcon />
          <span>{t('nav.switch_lang')}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={() => setTheme(nextTheme(theme))}
          tooltip={themeLabel}
        >
          <ThemeIcon />
          <span>{themeLabel}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={toggleSidebar} tooltip={t(collapsed ? 'nav.expand' : 'nav.collapse')}>
          {collapsed ? <PanelLeftOpenIcon className="size-4" /> : <PanelLeftCloseIcon className="size-4" />}
          <span>{t(collapsed ? 'nav.expand' : 'nav.collapse')}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
