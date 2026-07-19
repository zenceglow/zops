import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { encryptedLocalStorage } from '../lib/secure-storage';

interface AuthorizeStore {
  token?: string;
  /** false until encrypted persist finishes rehydrating */
  _hasHydrated: boolean;
  setToken: (v?: string) => void;
  logout: () => void;
}

const useAuthorizeStore = create<AuthorizeStore>()(
  persist(
    (set) => ({
      token: undefined,
      _hasHydrated: false,
      setToken: (v?: string) => set({ token: v }),
      logout: () => set({ token: undefined }),
    }),
    {
      name: 'ops-authorize-store',
      storage: createJSONStorage(() => encryptedLocalStorage),
      partialize: (state) => ({ token: state.token }),
      onRehydrateStorage: () => (state, err) => {
        if (err) {
          console.warn('authorize store rehydrate failed', err);
        }
        // Defer so we never touch the binding during create()
        queueMicrotask(() => {
          useAuthorizeStore.setState({ _hasHydrated: true });
        });
        void state;
      },
    },
  ),
);

export default useAuthorizeStore;
