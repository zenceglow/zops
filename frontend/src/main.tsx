import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  NavLink,
  useLocation,
} from 'react-router-dom';
import './i18n/i18n';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Globe,
  Container,
  Settings2,
  Sun,
  Moon,
  Monitor,
  Zap,
  LogOut,
  ChevronRight,
  Languages,
  MemoryStick,
  Network,
  Shield,
  Package,
  User,
} from 'lucide-react';
import { cn } from './lib/utils';
import { useThemeStore, resolveTheme, initTheme, type Theme } from './stores/theme-store';
import {
  SidebarProvider,
  useSidebar,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarRail,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  SidebarInset,
} from './components/ui/sidebar';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './components/ui/collapsible';
import { TooltipProvider } from './components/ui/tooltip';
import LoginPage from './pages/login';
import MonitorPage from './pages/monitor';
import SitesPage from './pages/sites';
import DockerContainersPage from './pages/docker/containers';
import DockerImagesPage from './pages/docker/images';
import DockerNetworksPage from './pages/docker/networks';
import DockerSettingsPage from './pages/docker/settings';
import SystemSwapPage from './pages/system/swap';
import SystemNetworkPage from './pages/system/network';
import SystemFirewallPage from './pages/system/firewall';
import SystemUpdatesPage from './pages/system/updates';
import './index.css';

export { cn } from './lib/utils';
export { api, login, apiGet, apiPost } from './lib/api';

/* ---------- Theme Init ---------- */

function ThemeInit() {
  useEffect(() => initTheme(), []);
  return null;
}

/* ---------- Nav Data ---------- */

interface NavSubItem {
  labelKey: string;
  path: string;
  icon?: React.ComponentType<{ className?: string }>;
}

interface NavEntry {
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  path?: string;
  subItems?: NavSubItem[];
}

const NAV_ENTRIES: NavEntry[] = [
  { labelKey: 'nav.monitor', icon: Activity, path: '/monitor' },
  { labelKey: 'nav.sites', icon: Globe, path: '/sites' },
  {
    labelKey: 'nav.docker',
    icon: Container,
    subItems: [
      { labelKey: 'docker.containers', path: '/docker/containers', icon: Container },
      { labelKey: 'docker.images', path: '/docker/images' },
      { labelKey: 'docker.networks', path: '/docker/networks' },
      { labelKey: 'docker.settings', path: '/docker/settings' },
    ],
  },
  {
    labelKey: 'nav.system',
    icon: Settings2,
    subItems: [
      { labelKey: 'system.swap', path: '/system/swap', icon: MemoryStick },
      { labelKey: 'system.network', path: '/system/network', icon: Network },
      { labelKey: 'system.firewall', path: '/system/firewall', icon: Shield },
      { labelKey: 'system.updates', path: '/system/updates', icon: Package },
    ],
  },
];

function pathMatches(pathname: string, p: string): boolean {
  if (p === '/monitor') return pathname === p;
  return pathname.startsWith(p);
}

/* ---------- Sidebar Sections ---------- */

function LogoSidebarHeader() {
  const { t } = useTranslation();
  const { state } = useSidebar();
  const collapsed = state === 'collapsed';

  return (
    <SidebarHeader>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" asChild tooltip={collapsed ? t('app.name') : undefined}>
            <NavLink to="/monitor">
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Zap className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">{t('app.name')}</span>
              </div>
            </NavLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>
  );
}

function NavSection({ entry }: { entry: NavEntry }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { state } = useSidebar();
  const collapsed = state === 'collapsed';

  if (entry.path) {
    const active = pathMatches(pathname, entry.path);
    return (
      <SidebarMenuItem>
        {/* Single asChild → NavLink (avoid nested Slot chains) */}
        <SidebarMenuButton asChild isActive={active} tooltip={t(entry.labelKey)}>
          <NavLink to={entry.path}>
            <entry.icon />
            <span>{t(entry.labelKey)}</span>
          </NavLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  if (entry.subItems) {
    return <CollapsibleNavItem entry={entry} collapsed={collapsed} pathname={pathname} />;
  }

  return null;
}

function CollapsibleNavItem({
  entry,
  collapsed,
  pathname,
}: {
  entry: NavEntry;
  collapsed: boolean;
  pathname: string;
}) {
  const { t } = useTranslation();
  const parentActive = entry.subItems!.some((s) => pathMatches(pathname, s.path));
  const [open, setOpen] = useState(parentActive);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton isActive={parentActive} tooltip={t(entry.labelKey)}>
            <entry.icon />
            <span>{t(entry.labelKey)}</span>
            <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {entry.subItems!.map((sub) => {
              const active = pathMatches(pathname, sub.path);
              return (
                <SidebarMenuSubItem key={sub.path}>
                  <SidebarMenuSubButton asChild isActive={active}>
                    <NavLink to={sub.path}>
                      {sub.icon && <sub.icon />}
                      <span>{t(sub.labelKey)}</span>
                    </NavLink>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              );
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

function SidebarNavigation() {
  return (
    <SidebarContent>
      <SidebarGroup>
        <SidebarMenu>
          {NAV_ENTRIES.map((entry) => (
            <NavSection key={entry.labelKey} entry={entry} />
          ))}
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>
  );
}

function SidebarActions() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const resolved = resolveTheme(theme);
  const { t, i18n } = useTranslation();

  const cycleTheme = () => {
    const next: Record<Theme, Theme> = { dark: 'light', light: 'system', system: 'dark' };
    setTheme(next[theme]);
  };

  const toggleLang = () => {
    const next = i18n.language === 'zh' ? 'en' : 'zh';
    i18n.changeLanguage(next);
    localStorage.setItem('ops-lang', next);
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    window.location.href = '/login';
  };

  const ThemeIcon = resolved === 'dark' ? Moon : resolved === 'light' ? Sun : Monitor;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-accent">
            <User className="size-4" />
          </div>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">Admin</span>
            <span className="truncate text-xs text-sidebar-foreground/60">admin@zenceglow</span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={toggleLang} tooltip={t('nav.switch_lang')}>
          <Languages />
          <span>{t('nav.switch_lang')}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={cycleTheme} tooltip={resolved}>
          <ThemeIcon />
          <span>{resolved === 'dark' ? 'Dark' : resolved === 'light' ? 'Light' : 'System'}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={handleLogout} tooltip={t('nav.logout')}>
          <LogOut />
          <span>{t('nav.logout')}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/* ---------- Layout ---------- */

function Layout({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('token');
  const { pathname } = useLocation();

  if (!token || pathname === '/login') {
    return <>{children}</>;
  }

  return (
    <SidebarProvider defaultOpen>
      <Sidebar collapsible="icon">
        <LogoSidebarHeader />
        <SidebarNavigation />
        <SidebarFooter>
          <SidebarActions />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

/* ---------- App ---------- */

function App() {
  return (
    <TooltipProvider>
      <BrowserRouter>
        <ThemeInit />
        <Layout>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/monitor" element={<MonitorPage />} />
            <Route path="/sites" element={<SitesPage />} />
            <Route path="/docker/containers" element={<DockerContainersPage />} />
            <Route path="/docker/images" element={<DockerImagesPage />} />
            <Route path="/docker/networks" element={<DockerNetworksPage />} />
            <Route path="/docker/settings" element={<DockerSettingsPage />} />
            <Route path="/system/swap" element={<SystemSwapPage />} />
            <Route path="/system/network" element={<SystemNetworkPage />} />
            <Route path="/system/firewall" element={<SystemFirewallPage />} />
            <Route path="/system/updates" element={<SystemUpdatesPage />} />
            <Route path="/docker" element={<Navigate to="/docker/containers" replace />} />
            <Route path="/system" element={<Navigate to="/system/swap" replace />} />
            <Route path="/dashboard" element={<Navigate to="/monitor" replace />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
