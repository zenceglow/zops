import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from '../../../components/ui/sonner';
import useAuthorizeStore from '../../../stores/authorize.store';
import useUserStore from '../../../stores/user.store';
import { Perm } from '../../../lib/permissions';
import { loginApi } from '../_api';

function homePathForPermissions(permissions: string[], role: string): string {
  if (role === 'super_admin' || permissions.includes(Perm.NAV_MONITOR)) return '/monitor';
  if (permissions.includes(Perm.NAV_SITES)) return '/sites';
  if (permissions.includes(Perm.NAV_SSH)) return '/ssh';
  if (permissions.includes(Perm.NAV_DOCKER)) return '/docker/containers';
  if (permissions.includes(Perm.NAV_SYSTEM)) return '/system/swap';
  if (permissions.includes(Perm.NAV_MEMBERS)) return '/members';
  return '/monitor';
}

export function useLogin() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPw, setShowPw] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await loginApi(username, password);
      if (!res.success || !res.data) {
        toast.error(res.message || t('login.error'));
        return;
      }
      const { access_token, username: name, role, permissions } = res.data;
      useAuthorizeStore.getState().setToken(access_token);
      useUserStore.getState().setUser({
        username: name,
        role,
        permissions,
      });
      // SPA navigate — avoid full reload racing encrypted token persist
      navigate(homePathForPermissions(permissions, role), { replace: true });
    } catch {
      toast.error(t('login.error'));
    } finally {
      setLoading(false);
    }
  };

  return {
    username,
    setUsername,
    password,
    setPassword,
    loading,
    showPw,
    setShowPw,
    submit,
  };
}
