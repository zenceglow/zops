import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Boxes, ExternalLink, PackageCheck } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Skeleton } from '../../components/ui/skeleton';
import { cn } from '../../lib/utils';
import { fetchApps, localized, type MarketApp } from './_api';
import { AppIcon } from './_components/app-icon';
import { InstallDialog } from './_components/install-dialog';

/**
 * 应用市场。
 *
 * 目标不是"列一堆能装的东西"，而是"把装一个数据库从半小时压到点一下"：镜像、
 * 端口、字符集、重启策略、日志轮转、数据卷、接哪个内网 —— 这些在清单里定好，
 * 用户只决定端口和密码。
 *
 * 一个卡片上必须能回答三个问题，否则它就不合格：**这是什么东西**（品牌图标 +
 * 一句话）、**装完占什么**（镜像与端口）、**我装了没有**（安装态徽标）。
 *
 * 目录现在来自后端的内置清单（`domain::app_catalog`）。以后换成本地拉
 * ops.zenceglow.com 的开放平台目录时，这个页面一行都不用改 —— 形状是一样的。
 */
export default function MarketPage() {
  const { t, i18n } = useTranslation();
  const [apps, setApps] = useState<MarketApp[] | null>(null);
  const [target, setTarget] = useState<MarketApp | null>(null);
  const [open, setOpen] = useState(false);

  const reload = useCallback(async () => {
    try {
      setApps(await fetchApps());
    } catch {
      setApps([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const launch = (app: MarketApp) => {
    setTarget(app);
    setOpen(true);
  };

  if (!apps) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('market.title')} subtitle={t('market.subtitle')} />
        <div className="grid gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-44 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  const installedCount = apps.filter((a) => a.installed).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('market.title')}
        subtitle={t('market.subtitle')}
        extra={
          installedCount > 0 ? (
            <span className="text-xs text-muted-foreground">
              {t('market.installed_count', { n: installedCount, total: apps.length })}
            </span>
          ) : null
        }
      />

      {apps.length === 0 ? (
        <div className="rounded-2xl border border-border/60 py-12 text-center">
          <Boxes className="mx-auto size-7 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">{t('market.empty')}</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {apps.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              zh={i18n.language.startsWith('zh')}
              onDeploy={() => launch(app)}
            />
          ))}
        </div>
      )}

      <InstallDialog
        app={target}
        open={open}
        onOpenChange={setOpen}
        onInstalled={() => void reload()}
      />
    </div>
  );
}

function PageHeader({
  title,
  subtitle,
  extra,
}: {
  title: string;
  subtitle: string;
  extra?: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {extra}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
    </div>
  );
}

function AppCard({
  app,
  zh,
  onDeploy,
}: {
  app: MarketApp;
  zh: boolean;
  onDeploy: () => void;
}) {
  const { t } = useTranslation();
  const installed = app.installed;

  return (
    <div className="flex flex-col rounded-2xl border border-border/60 p-4">
      <div className="flex items-start gap-3">
        <AppIcon appId={app.id} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-base font-medium">{app.name}</span>
            <span className="text-xs text-muted-foreground">{app.version}</span>
            {installed && (
              <Badge
                variant="outline"
                className="ml-auto gap-1 border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
              >
                <PackageCheck className="size-3" />
                {t('market.installed')}
              </Badge>
            )}
          </div>
          <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
            {app.image}
          </div>
        </div>
      </div>

      <p className="mt-3 text-sm text-muted-foreground">
        {localized(app.tagline, app.tagline_en)}
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {app.ports.map((p) => (
          // 已装的应用显示**实际**端口而不是默认值：默认值是"清单建议"，实际端口
          // 才是"你现在该拿它去连的那个"。
          <PortChip
            key={p.key}
            label={localized(p.label, p.label_en)}
            port={installed?.ports?.[p.key] ?? p.host_default}
            changed={!!installed && installed.ports?.[p.key] !== p.host_default}
          />
        ))}
        {app.volumes.length > 0 && (
          <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {app.volumes.map((v) => v.host).join(' ')}
          </span>
        )}
      </div>

      {installed && (
        <div className="mt-3 space-y-0.5 text-xs text-muted-foreground">
          <div>
            {t('market.installed_as')}
            <span className="ml-1 font-mono">{installed.name}</span>
          </div>
          <div className="truncate" title={installed.dir}>
            <span className="font-mono">{installed.dir}</span>
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2 pt-1">
        <Button size="sm" variant={installed ? 'outline' : 'default'} onClick={onDeploy}>
          {installed ? t('market.redeploy') : t('market.deploy')}
        </Button>
        {installed && (
          <Button size="sm" variant="ghost" asChild>
            <Link to="/deploy">
              {t('market.view_in_apps')}
              <ExternalLink />
            </Link>
          </Button>
        )}
        <a
          href={app.docs}
          target="_blank"
          rel="noreferrer"
          className={cn(
            'ml-auto text-xs text-muted-foreground transition-colors hover:text-foreground',
          )}
        >
          {t('market.official_docs')}
        </a>
      </div>
    </div>
  );
}

function PortChip({
  label,
  port,
  changed,
}: {
  label: string;
  port: number;
  changed: boolean;
}) {
  return (
    <span
      className={cn(
        'rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground',
        changed && 'bg-primary/10 text-foreground',
      )}
    >
      {label} <span className="font-mono">{port}</span>
    </span>
  );
}
