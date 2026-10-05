import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileCog, Play, RotateCw, ScrollText, Square } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import { cn } from '../../../lib/utils';
import type { GatewayStatus } from '../_api';

interface Props {
  status: GatewayStatus;
  busy: boolean;
  onAction: (action: 'start' | 'stop' | 'reload') => void;
  onShowLogs: () => void;
}

/** 一格元数据：小字标签 + 等宽值，值太长就截断（完整内容放 title）。 */
function Meta({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] tracking-wider text-muted-foreground uppercase">{label}</p>
      <p className="mt-0.5 truncate font-mono text-xs" title={title ?? value}>
        {value}
      </p>
    </div>
  );
}

/**
 * 相对时间自己会走。
 *
 * 这一页只在挂载和操作后取状态，"3 分钟前"不刷新的话会一直停在 3 分钟。
 */
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * 网关状态条。
 *
 * 之前这里只有一枚"运行中/已停止"角标加一行 PID —— 用户其实想问的是三件事：
 * 它在跑吗、它是怎么跑的（容器还是本机装的）、我改的那份配置生效了没。所以除了
 * 状态，把运行方式、版本、PID/容器名、配置修改时间一起摆出来，配置文件路径单独
 * 占一行（它很长，混在按钮旁边会把整行撑歪）。
 */
export function GatewayStatusCard({ status, busy, onAction, onShowLogs }: Props) {
  const { t } = useTranslation();
  const now = useNow();
  const running = status.running;

  const runtimeLabel =
    status.runtime === 'docker'
      ? t('sites.runtime_docker', { name: status.container ?? 'caddy' })
      : status.runtime === 'binary'
        ? t('sites.runtime_binary')
        : t('sites.runtime_none');

  // `caddy version` 输出是 "v2.11.7 h1:yj0Y4f…" —— 构建哈希有三十多个字符，摆在
  // 状态条上只会把别的信息挤走。只留版本号，完整字符串放 title。
  const version = status.version.split(' ')[0] || '';

  let modifiedLabel = t('sites.config_never');
  if (status.config_modified !== null) {
    const secs = Math.max(0, Math.floor((now - status.config_modified) / 1000));
    if (secs < 60) modifiedLabel = t('ago.just_now');
    else if (secs < 3600) modifiedLabel = t('ago.minutes', { count: Math.floor(secs / 60) });
    else if (secs < 86_400) modifiedLabel = t('ago.hours', { count: Math.floor(secs / 3600) });
    else modifiedLabel = t('ago.days', { count: Math.floor(secs / 86_400) });
  }

  return (
    <Card size="sm" className="gap-3 py-0">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 pt-3.5">
        <span className="flex items-center gap-2">
          <span className="relative flex size-2.5 items-center justify-center">
            {running && (
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60" />
            )}
            <span
              className={cn(
                'relative inline-flex size-2 rounded-full',
                running ? 'bg-emerald-500' : 'bg-muted-foreground/40',
              )}
            />
          </span>
          <span className="text-sm font-medium">
            {running ? t('sites.running') : t('sites.stopped')}
          </span>
        </span>

        <Meta label={t('sites.runtime')} value={runtimeLabel} />
        <Meta label={t('sites.version')} value={version || '—'} title={status.version} />
        <Meta
          label={status.runtime === 'docker' ? t('sites.container') : t('sites.pid')}
          value={
            status.runtime === 'docker'
              ? (status.container ?? '—')
              : status.pid === null
                ? '—'
                : String(status.pid)
          }
        />
        <Meta label={t('sites.config_modified')} value={modifiedLabel} />

        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={onShowLogs}>
            <ScrollText />
            {t('sites.view_logs')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy || running} onClick={() => onAction('start')}>
            <Play />
            {t('sites.start')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !running} onClick={() => onAction('stop')}>
            <Square />
            {t('sites.stop')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !running} onClick={() => onAction('reload')}>
            <RotateCw />
            {t('sites.reload')}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-border/60 px-4 py-2.5">
        <FileCog className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className="truncate font-mono text-xs text-muted-foreground"
          title={status.caddyfile_path}
        >
          {status.caddyfile_path}
        </span>
      </div>
    </Card>
  );
}
