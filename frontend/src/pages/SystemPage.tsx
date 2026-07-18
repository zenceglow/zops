import React from 'react';
import { useTranslation } from 'react-i18next';
import { MemoryStick, Network, Shield, Package } from 'lucide-react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { Card, CardContent } from '../components/ui/card';

function Placeholder({
  icon: Icon,
  title,
  desc,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  desc?: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <Icon className="size-8 mb-3 opacity-40" />
        <p className="text-sm">{title}</p>
        {desc && <p className="text-xs mt-2 text-muted-foreground/70 max-w-sm text-center">{desc}</p>}
      </CardContent>
    </Card>
  );
}

export default function SystemPage() {
  const { t } = useTranslation();
  const { pathname } = useLocation();

  const titleMap: Record<string, string> = {
    '/system/swap': 'system.swap',
    '/system/network': 'system.network',
    '/system/firewall': 'system.firewall',
    '/system/updates': 'system.updates',
  };
  const titleKey =
    Object.entries(titleMap).find(([p]) => pathname.startsWith(p))?.[1] || 'system.title';

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">
        {t('system.title')}
        <span className="text-lg font-normal text-muted-foreground ml-2">/</span>
        <span className="text-lg font-normal text-muted-foreground ml-2">{t(titleKey)}</span>
      </h1>
      <Routes>
        <Route
          path="/"
          element={
            <Placeholder icon={MemoryStick} title={t('system.swap')} desc={t('system.swap_desc')} />
          }
        />
        <Route
          path="/swap"
          element={
            <Placeholder icon={MemoryStick} title={t('system.swap')} desc={t('system.swap_desc')} />
          }
        />
        <Route
          path="/network"
          element={<Placeholder icon={Network} title={t('system.network')} />}
        />
        <Route
          path="/firewall"
          element={
            <Placeholder
              icon={Shield}
              title={t('system.firewall')}
              desc={t('system.firewall_desc')}
            />
          }
        />
        <Route
          path="/updates"
          element={
            <Placeholder
              icon={Package}
              title={t('system.updates')}
              desc={t('system.updates_desc')}
            />
          }
        />
      </Routes>
    </div>
  );
}
