import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './i18n/i18n';
import { TooltipProvider } from './components/ui/tooltip';
import { Toaster } from './components/ui/sonner';
import { ThemeProvider } from './providers/theme-provider';
import { SetupGate } from './providers/setup-provider';
import { SessionSync } from './providers/session-provider';
import { RequireAuth } from './providers/auth-provider';
import { AppLayout } from './components/layouts/app-layout';
import { AppRoutes } from './router/router-mapping';
import './index.css';

function App() {
  return (
    <TooltipProvider>
      <BrowserRouter>
        <ThemeProvider />
        <Toaster />
        <SetupGate>
          <SessionSync />
          <RequireAuth>
            <AppLayout>
              <AppRoutes />
            </AppLayout>
          </RequireAuth>
        </SetupGate>
      </BrowserRouter>
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
