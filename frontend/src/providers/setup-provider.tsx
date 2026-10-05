import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import i18n from '../i18n/i18n';
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
          // 安装时选的语言就是面板的默认语言。用户自己切过一次之后
          // localStorage 里就有值了，那种情况以他的选择为准，不再覆盖。
          const lang = res.data?.default_lang;
          if (lang && !localStorage.getItem('ops-lang') && i18n.language !== lang) {
            void i18n.changeLanguage(lang);
          }
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
