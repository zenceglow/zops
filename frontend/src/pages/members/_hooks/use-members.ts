import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '../../../components/ui/sonner';
import {
  createMember,
  deleteMember,
  listMembers,
  updateMember,
  type MemberInfo,
} from '../_api';

export function useMembers() {
  const { t } = useTranslation();
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const m = await listMembers();
      if (m.success && m.data) setMembers(m.data);
      else toast.error(m.message || t('members.load_fail'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('members.load_fail'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async (username: string, password: string, permissions: string[]) => {
    const res = await createMember({ username, password, permissions });
    if (!res.success) {
      toast.error(res.message || t('members.create_fail'));
      return false;
    }
    toast.success(t('members.create_ok'));
    await refresh();
    return true;
  };

  const savePerms = async (id: number, permissions: string[]) => {
    const res = await updateMember({ id, permissions });
    if (!res.success) {
      toast.error(res.message || t('members.update_fail'));
      return false;
    }
    toast.success(t('members.update_ok'));
    await refresh();
    return true;
  };

  const resetPassword = async (id: number, password: string) => {
    const res = await updateMember({ id, password });
    if (!res.success) {
      toast.error(res.message || t('members.update_fail'));
      return false;
    }
    toast.success(t('members.password_ok'));
    return true;
  };

  const remove = async (id: number) => {
    const res = await deleteMember(id);
    if (!res.success) {
      toast.error(res.message || t('members.delete_fail'));
      return false;
    }
    toast.success(t('members.delete_ok'));
    await refresh();
    return true;
  };

  return {
    members,
    loading,
    refresh,
    add,
    savePerms,
    resetPassword,
    remove,
  };
}
