import { useEffect } from 'react';
import { fetchMe } from '../pages/login/_api';
import useAuthorizeStore from '../stores/authorize.store';
import usePermissionCatalog from '../stores/permission.store';
import useUserStore from '../stores/user.store';

export function SessionSync() {
  const token = useAuthorizeStore((s) => s.token);
  const hasHydrated = useAuthorizeStore((s) => s._hasHydrated);
  const setUser = useUserStore((s) => s.setUser);
  const fetchCatalog = usePermissionCatalog((s) => s.fetchCatalog);

  useEffect(() => {
    if (!hasHydrated || !token) return;
    let cancelled = false;

    fetchMe()
      .then((res) => {
        if (cancelled || !res.success || !res.data) return;
        setUser({
          id: res.data.id,
          username: res.data.username,
          role: res.data.role,
          permissions: res.data.permissions,
        });
      })
      .catch(() => {
        /* 401 handled by api client */
      });

    // Catalog is independent — must not block session restore
    void fetchCatalog();

    return () => {
      cancelled = true;
    };
  }, [hasHydrated, token, setUser, fetchCatalog]);

  return null;
}
