import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Play, RefreshCw, RotateCw, Square } from 'lucide-react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Card, CardContent } from '../../../components/ui/card';
import { Skeleton } from '../../../components/ui/skeleton';
import {
  containerAction,
  fetchContainer,
  fetchContainerLogs,
  type ContainerInfo,
} from './_api';

const LOG_POLL_MS = 5000;

/**
 * 单个容器的详情。
 *
 * 首页那排图标点进来就是这里。之所以要有：容器出问题时（502、起不来、跑飞了）
 * 最先要看的永远是**日志**，而在此之前只能跳到列表页、再自己去找哪里能看日志。
 */
export default function ContainerDetailPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const [container, setContainer] = useState<ContainerInfo | null>(null);
  const [logs, setLogs] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetchContainer(id)
      .then((d) => setContainer(d.container))
      .catch(() => setContainer(null))
      .finally(() => setLoading(false));
  }, [id]);

  const loadLogs = useCallback(() => {
    fetchContainerLogs(id)
      .then(setLogs)
      .catch(() => setLogs(''));
  }, [id]);

  useEffect(() => {
    load();
    loadLogs();
  }, [load, loadLogs]);

  // 日志自己滚：看日志基本都是在等它冒出新行，手动刷是反着用。
  useEffect(() => {
    const timer = setInterval(loadLogs, LOG_POLL_MS);
    return () => clearInterval(timer);
  }, [loadLogs]);

  const act = async (action: 'start' | 'stop' | 'restart') => {
    setBusy(true);
    try {
      await containerAction(id, action);
      // 容器状态变化不是瞬间生效的，等一拍再读，看到的才是新状态。
      setTimeout(() => {
        load();
        loadLogs();
      }, 800);
    } finally {
      setBusy(false);
    }
  };

  const running = container?.state === 'running';
  const startTime = container?.started_at ? new Date(container.started_at.replace(/(\.\d{3})\d+/, '$1')) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          to="/docker/containers"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t('docker.back_to_list')}
        </Link>
      </div>

      {loading ? (
        <Skeleton className="h-24 w-full rounded-2xl" />
      ) : !container ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {t('docker.not_found')}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <span className="flex size-11 items-center justify-center rounded-2xl bg-foreground text-background">
              <span className="text-lg font-bold">{container.image.slice(0, 1).toUpperCase()}</span>
            </span>
            <div className="min-w-0">
              <h1 className="truncate font-mono text-lg font-semibold">{container.name}</h1>
              <p className="truncate text-xs text-muted-foreground">{container.image}</p>
            </div>
            <Badge variant={running ? 'default' : 'secondary'}>{container.status}</Badge>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" disabled={busy || running} onClick={() => act('start')}>
                <Play />
                {t('sites.start')}
              </Button>
              <Button size="sm" variant="outline" disabled={busy || !running} onClick={() => act('stop')}>
                <Square />
                {t('sites.stop')}
              </Button>
              <Button size="sm" variant="outline" disabled={busy || !running} onClick={() => act('restart')}>
                <RotateCw />
                {t('docker.restart')}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { k: t('docker.ports'), v: container.ports || '—' },
              { k: t('docker.started'), v: startTime && !Number.isNaN(startTime.getTime()) ? startTime.toLocaleString() : '—' },
              { k: t('monitor.cpu'), v: container.cpu_percent === null ? '—' : `${container.cpu_percent.toFixed(1)}%` },
              {
                k: t('monitor.memory'),
                v: container.mem_used === null ? '—' : `${Math.round(container.mem_used / (1 << 20))} MB`,
              },
            ].map((row) => (
              <div key={row.k} className="rounded-xl border border-border/60 px-3.5 py-2.5">
                <p className="text-xs text-muted-foreground">{row.k}</p>
                <p className="mt-0.5 truncate font-mono text-sm" title={row.v}>
                  {row.v}
                </p>
              </div>
            ))}
          </div>

          <div className="rounded-2xl border border-border/60">
            <div className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5">
              <span className="text-sm font-medium">{t('docker.logs')}</span>
              <span className="text-xs text-muted-foreground">{t('docker.logs_auto')}</span>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={loadLogs}>
                <RefreshCw />
                {t('docker.refresh')}
              </Button>
            </div>
            <pre className="max-h-[52vh] overflow-y-auto whitespace-pre-wrap break-all px-4 py-3 font-mono text-xs leading-5 text-muted-foreground">
              {logs || t('docker.logs_empty')}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}
