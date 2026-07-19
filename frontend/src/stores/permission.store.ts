import { create } from 'zustand';
import { listPermissions, type PermissionDef } from '../pages/members/_api';

interface PermissionCatalogStore {
  catalog: PermissionDef[];
  loaded: boolean;
  fetchCatalog: () => Promise<void>;
}

const usePermissionCatalog = create<PermissionCatalogStore>((set, get) => ({
  catalog: [],
  loaded: false,
  fetchCatalog: async () => {
    if (get().loaded) return;
    try {
      const res = await listPermissions();
      if (res.success && res.data) {
        set({ catalog: res.data, loaded: true });
      }
    } catch {
      /* ignore; catalog stays empty, UI falls back to raw IDs */
    }
  },
}));

export default usePermissionCatalog;
