import React, { createContext, useContext, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import './index.css';

const api = (path: string) => `/api/ops${path}`;

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(api('/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error('登录失败');
  const data = await res.json();
  return data.token;
}

async function apiGet<T>(path: string): Promise<T> {
  const token = localStorage.getItem('token');
  const res = await fetch(api(path), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    localStorage.removeItem('token');
    window.location.href = '/login';
    throw new Error('未授权');
  }
  return res.json();
}

async function apiPost(path: string, body?: unknown): Promise<any> {
  const token = localStorage.getItem('token');
  const res = await fetch(api(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    localStorage.removeItem('token');
    window.location.href = '/login';
    throw new Error('未授权');
  }
  return res.json();
}

export { api, login, apiGet, apiPost };

// ---------- Dark Mode Context ----------

type Theme = 'light' | 'dark' | 'system';

const ThemeContext = createContext<{
  theme: Theme;
  resolved: 'light' | 'dark';
  setTheme: (t: Theme) => void;
}>({ theme: 'system', resolved: 'dark', setTheme: () => {} });

export function useTheme() {
  return useContext(ThemeContext);
}

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem('ops-theme') as Theme | null;
    return stored ?? 'system';
  });
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  const resolved: 'light' | 'dark' =
    theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
    localStorage.setItem('ops-theme', theme);
  }, [resolved, theme]);

  const setTheme = (t: Theme) => setThemeState(t);

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  const { resolved, setTheme } = useTheme();
  return (
    <div className="min-h-screen">
      {/* corner theme toggle */}
      <button
        onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
        className="fixed top-4 right-4 z-50 w-9 h-9 flex items-center justify-center rounded-full
                   bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700
                   text-lg cursor-pointer border-0"
        title="切换主题"
      >
        {resolved === 'dark' ? '☀️' : '🌙'}
      </button>
      {children}
    </div>
  );
}

function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </ThemeProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
