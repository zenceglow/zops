import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BrandLogo } from '../brand-logo';
import {
  useSidebar,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from '../ui/sidebar';

export function LogoSidebarHeader() {
  const { t } = useTranslation();
  const { state } = useSidebar();
  const collapsed = state === 'collapsed';

  return (
    <SidebarHeader>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" asChild tooltip={collapsed ? t('app.name') : undefined}>
            <NavLink to="/monitor" className="group-data-[collapsible=icon]:justify-center">
              <BrandLogo className="size-5" />
              <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate font-semibold">{t('app.name')}</span>
              </div>
            </NavLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>
  );
}
