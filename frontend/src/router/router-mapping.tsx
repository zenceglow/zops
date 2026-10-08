import { Suspense, lazy, type ComponentType } from 'react';
import { Route, Routes, Navigate } from 'react-router-dom';

type RouteDef = {
  path: string;
  lazy: () => Promise<{ default: ComponentType }>;
};

function page(importer: () => Promise<unknown>): () => Promise<{ default: ComponentType }> {
  return () => importer() as Promise<{ default: ComponentType }>;
}

export const APP_ROUTES: RouteDef[] = [
  { path: '/setup', lazy: page(() => import('../pages/setup')) },
  { path: '/login', lazy: page(() => import('../pages/login')) },
  { path: '/monitor', lazy: page(() => import('../pages/monitor')) },
  { path: '/screen', lazy: page(() => import('../pages/screen')) },
  { path: '/analytics', lazy: page(() => import('../pages/analytics')) },
  { path: '/about', lazy: page(() => import('../pages/about')) },
  { path: '/sites', lazy: page(() => import('../pages/sites')) },
  { path: '/ssh', lazy: page(() => import('../pages/ssh')) },
  { path: '/files', lazy: page(() => import('../pages/files')) },
  { path: '/deploy', lazy: page(() => import('../pages/deploy')) },
  { path: '/market', lazy: page(() => import('../pages/market')) },
  { path: '/logs', lazy: page(() => import('../pages/logs')) },
  { path: '/security', lazy: page(() => import('../pages/security')) },
  { path: '/automation/tasks', lazy: page(() => import('../pages/automation/tasks')) },
  { path: '/agent', lazy: page(() => import('../pages/agent')) },
  { path: '/notify', lazy: page(() => import('../pages/notify')) },
  { path: '/members', lazy: page(() => import('../pages/members')) },
  { path: '/profile', lazy: page(() => import('../pages/profile')) },
  { path: '/settings/system', lazy: page(() => import('../pages/settings/system')) },
  { path: '/settings/panel', lazy: page(() => import('../pages/settings/panel')) },
  { path: '/docker', lazy: page(() => import('../pages/docker')) },
  { path: '/docker/containers', lazy: page(() => import('../pages/docker/containers')) },
  { path: '/docker/containers/:id', lazy: page(() => import('../pages/docker/containers/detail')) },
  { path: '/docker/images', lazy: page(() => import('../pages/docker/images')) },
  { path: '/docker/networks', lazy: page(() => import('../pages/docker/networks')) },
  { path: '/docker/settings', lazy: page(() => import('../pages/docker/settings')) },
  { path: '/system/swap', lazy: page(() => import('../pages/system/swap')) },
  { path: '/system/network', lazy: page(() => import('../pages/system/network')) },
  { path: '/network', lazy: page(() => import('../pages/network')) },
  { path: '/system/updates', lazy: page(() => import('../pages/system/updates')) },
];

/** Create lazy components once — recreating inside render remounts forever. */
const LAZY_ROUTES = APP_ROUTES.map((r) => ({
  path: r.path,
  Page: lazy(r.lazy),
}));

const FALLBACKS: [string, string][] = [
  ['/docker', '/docker/containers'],
  ['/system', '/system/swap'],
  ['/automation', '/automation/tasks'],
  ['/system/firewall', '/security'],
  ['/dashboard', '/monitor'],
];

function RouteFallback() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
      Loading…
    </div>
  );
}

export function AppRoutes() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/" element={<Navigate to="/monitor" replace />} />
        {LAZY_ROUTES.map(({ path, Page }) => (
          <Route key={path} path={path} element={<Page />} />
        ))}
        {FALLBACKS.map(([from, to]) => (
          <Route key={from} path={from} element={<Navigate to={to} replace />} />
        ))}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </Suspense>
  );
}
