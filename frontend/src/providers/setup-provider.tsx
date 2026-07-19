import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { getSetupStatus } from '../pages/setup/_api';

export function SetupGate({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const [ready, setReady] = useState(false);
  const [initialized, setInitialized] = useState(true);

  // Fetch once — do not re-run on every route change
  useEffect(() => {
    let cancelled = false;
    getSetupStatus()
      .then((res) => {
        if (!cancelled) {
          setInitialized(!!res.data?.initialized);
          setReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  const onSetup = pathname.startsWith('/setup');
  if (!initialized && !onSetup) {
    return <Navigate to="/setup" replace />;
  }
  if (initialized && onSetup) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
