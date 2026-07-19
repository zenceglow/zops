import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ROLE_SUPER_ADMIN } from '../lib/permissions';

export type OpsUser = {
  id?: number;
  username: string;
  role?: string;
  permissions?: string[];
};

interface UserStore {
  user?: OpsUser;
  _hasHydrated: boolean;
  setUser: (v?: OpsUser) => void;
  clear: () => void;
  hasPermission: (perm: string) => boolean;
}

const useUserStore = create<UserStore>()(
  persist(
    (set, get) => ({
      user: undefined,
      _hasHydrated: false,
      setUser: (v?: OpsUser) => set({ user: v }),
      clear: () => set({ user: undefined }),
      hasPermission: (perm: string) => {
        const u = get().user;
        if (!u) return false;
        if (u.role === ROLE_SUPER_ADMIN) return true;
        return (u.permissions ?? []).includes(perm);
      },
    }),
    {
      name: 'ops-user-store',
      partialize: (state) => ({ user: state.user }),
      onRehydrateStorage: () => (state, err) => {
        if (err) console.warn('user store rehydrate failed', err);
        // Defer — sync rehydrate runs during create(), before the binding exists
        queueMicrotask(() => {
          useUserStore.setState({ _hasHydrated: true });
        });
        void state;
      },
    },
  ),
);

export default useUserStore;
