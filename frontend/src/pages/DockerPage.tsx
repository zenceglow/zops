import React from 'react';
import { useTranslation } from 'react-i18next';
import { Container, Image, Network, Settings } from 'lucide-react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { Card, CardContent } from '../components/ui/card';

function Placeholder({
  icon: Icon,
  title,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <Icon className="size-8 mb-3 opacity-40" />
        <p className="text-sm">{title}</p>
      </CardContent>
    </Card>
  );
}

export default function DockerPage() {
  const { t } = useTranslation();
  const { pathname } = useLocation();

  const titleMap: Record<string, string> = {
    '/docker/containers': 'docker.containers',
    '/docker/images': 'docker.images',
    '/docker/networks': 'docker.networks',
    '/docker/settings': 'docker.settings',
  };
  const titleKey =
    Object.entries(titleMap).find(([p]) => pathname.startsWith(p))?.[1] || 'docker.title';

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">
        {t('docker.title')}
        <span className="text-lg font-normal text-muted-foreground ml-2">/</span>
        <span className="text-lg font-normal text-muted-foreground ml-2">{t(titleKey)}</span>
      </h1>
      <Routes>
        <Route
          path="/"
          element={<Placeholder icon={Container} title={t('docker.containers')} />}
        />
        <Route
          path="/containers"
          element={<Placeholder icon={Container} title={t('docker.containers')} />}
        />
        <Route
          path="/images"
          element={<Placeholder icon={Image} title={t('docker.images')} />}
        />
        <Route
          path="/networks"
          element={<Placeholder icon={Network} title={t('docker.networks')} />}
        />
        <Route
          path="/settings"
          element={<Placeholder icon={Settings} title={t('docker.settings')} />}
        />
      </Routes>
    </div>
  );
}
