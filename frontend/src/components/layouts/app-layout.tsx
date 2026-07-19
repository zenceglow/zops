import { useLocation } from 'react-router-dom';
import {
  SidebarProvider,
  Sidebar,
  SidebarFooter,
  SidebarInset,
  SidebarRail,
} from '../ui/sidebar';
import useAuthorizeStore from '../../stores/authorize.store';
import { LogoSidebarHeader } from './sidebar-header';
import { SidebarNavigation } from './sidebar-nav';
import { SidebarActions } from './sidebar-footer';

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
