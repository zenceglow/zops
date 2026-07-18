import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark' | 'system';

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

function getSystemDark(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') return getSystemDark() ? 'dark' : 'light';
  return theme;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'system',
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: 'ops-theme',
    },
  ),
);

/* ---------- Theme initializer (runs once on app mount) ---------- */

export function initTheme() {
  const { theme } = useThemeStore.getState();
  applyTheme(theme);

  // Listen for system preference changes
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    const current = useThemeStore.getState().theme;
    if (current === 'system') applyTheme('system');
  };
  mq.addEventListener('change', handler);

  // Subscribe to store changes
  const unsub = useThemeStore.subscribe((state) => {
    applyTheme(state.theme);
  });

  return () => {
    mq.removeEventListener('change', handler);
    unsub();
  };
}

function applyTheme(theme: Theme) {
  const resolved = resolveTheme(theme);
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}
