import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { NavChevronIcon } from '../icons/nav-icons';
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  useSidebar,
} from '../ui/sidebar';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible';
import { isParent, pathMatches, type SidebarItem } from '../../lib/sidebar-config';
import useUserStore from '../../stores/user.store';
import { SIDEBAR_GROUPS } from '../../router/sider-menu';

function NavLinkItem({
  path,
  labelKey,
  icon: Icon,
}: {
  path: string;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const active = pathMatches(pathname, path);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={t(labelKey)}>
        <NavLink to={path}>
          <Icon />
          <span>{t(labelKey)}</span>
        </NavLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function CollapsibleSubNav({
  labelKey,
  icon: Icon,
  children,
}: {
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  children: { path: string; labelKey: string; icon: React.ComponentType<{ className?: string }> }[];
}) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { state } = useSidebar();
  const collapsed = state === 'collapsed';
  const parentActive = children.some((s) => pathMatches(pathname, s.path));
  const [open, setOpen] = useState(parentActive);

  /* When collapsed, render a plain link to the first child — no expand. */
  if (collapsed) {
    const first = children[0];
    return (
      <SidebarMenuItem>
        <SidebarMenuButton asChild isActive={parentActive} tooltip={t(labelKey)}>
          <NavLink to={first.path}>
            <Icon />
            <span>{t(labelKey)}</span>
          </NavLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip={t(labelKey)}>
            <Icon />
            <span>{t(labelKey)}</span>
            <NavChevronIcon className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenu className="gap-1 pl-4">
            {children.map((sub) => (
              <NavLinkItem key={sub.path} {...sub} />
            ))}
          </SidebarMenu>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

export function SidebarNavigation() {
  const hasPermission = useUserStore((s) => s.hasPermission);
  const { t } = useTranslation();

  return (
    <SidebarContent>
      {SIDEBAR_GROUPS.map((grp) => {
        const visible = grp.items.filter((item: SidebarItem) => hasPermission(item.perm));
        if (visible.length === 0) return null;

        return (
          <SidebarGroup key={grp.labelKey} className="py-0.5">
            <SidebarGroupLabel>{t(grp.labelKey)}</SidebarGroupLabel>
            <SidebarMenu className="gap-1">
              {visible.map((item: SidebarItem) =>
                isParent(item) ? (
                  <CollapsibleSubNav
                    key={item.labelKey}
                    labelKey={item.labelKey}
                    icon={item.icon}
                    children={item.children}
                  />
                ) : (
                  <NavLinkItem
                    key={item.path}
                    path={item.path}
                    labelKey={item.labelKey}
                    icon={item.icon}
                  />
                ),
              )}
            </SidebarMenu>
          </SidebarGroup>
        );
      })}
    </SidebarContent>
  );
}
