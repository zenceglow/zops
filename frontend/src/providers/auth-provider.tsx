import { Navigate, useLocation } from 'react-router-dom';
import useAuthorizeStore from '../stores/authorize.store';
import useUserStore from '../stores/user.store';
import {
  SIDEBAR_GROUPS,
  PERM_MAP,
} from '../router/sider-menu';
import {
  firstAllowedPath as resolveFirstPath,
  pathPermission as resolvePathPerm,
} from '../lib/sidebar-config';

function pathPermission(pathname: string): string | null {
  return resolvePathPerm(pathname, PERM_MAP);
}

function firstAllowedPath(hasPermission: (p: string) => boolean): string {
  return resolveFirstPath(SIDEBAR_GROUPS, hasPermission);
}

function LoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
      Loading…
    </div>
  );
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = useAuthorizeStore((s) => s.token);
  const authHydrated = useAuthorizeStore((s) => s._hasHydrated);
  const userHydrated = useUserStore((s) => s._hasHydrated);
  const user = useUserStore((s) => s.user);
  const hasPermission = useUserStore((s) => s.hasPermission);
  const { pathname } = useLocation();

  if (!authHydrated || !userHydrated) {
    return <LoadingScreen />;
  }


  if (pathname === '/login' || pathname.startsWith('/setup')) {
    // Already signed in → leave login page
    if (pathname === '/login' && token && user?.role) {
      return <Navigate to={firstAllowedPath(hasPermission)} replace />;
    }
    return <>{children}</>;
  }

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  // Token present but profile not ready yet (SessionSync in flight)
  if (!user?.role) {
    return <LoadingScreen />;
  }

  const need = pathPermission(pathname);
  if (need && !hasPermission(need)) {
    return <Navigate to={firstAllowedPath(hasPermission)} replace />;
  }

  return <>{children}</>;
}
