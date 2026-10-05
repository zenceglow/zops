import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowRight, ExternalLink } from 'lucide-react';
import { SiCaddy } from 'react-icons/si';
import { Skeleton } from '../../../components/ui/skeleton';
import type { GatewayStatus, SiteEntry } from '../../sites/_api';
import { siteUrl } from '../../../lib/site-url';
import { cn } from '../../../lib/utils';

/**
 * 首页的站点入口。
 *
 * 刻意跟容器那排不一样：那是"机器上跑着什么"，这是"外面的人从哪儿进来"。所以给它
 * 卡片壳、品牌色图标和明确的箭头 —— 一排图标里混着它的话，看不出这是个门。
 */
export function GatewayEntry({
  status,
  sites,
  settled,
}: {
  status: GatewayStatus | null;
  sites: SiteEntry[];
  settled: boolean;
}) {
  const { t } = useTranslation();

  // 状态没回来时占住同样的位置：直接 return null 的话，卡片会在数据到达的瞬间冒
  // 出来，把下面的统计环整体往下顶一格 —— 比"先看到骨架"更难受。
  if (!status && !settled) {
    return (
      <section className="flex flex-wrap items-center gap-x-5 gap-y-4 rounded-2xl border border-border/70 px-5 py-4">
        <Skeleton className="size-12 shrink-0 rounded-2xl" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-6 w-72 max-w-full rounded-lg" />
        </div>
        <Skeleton className="h-8 w-24 shrink-0 rounded-xl" />
      </section>
    );
  }
  // 拉不到状态（接口挂了）就整块不显示，别把骨架留在页面上。
  if (!status) return null;

  const running = status.running;
  const domains = sites.map((s) => s.addr).filter(Boolean);
  const shown = domains.slice(0, 4);
  const rest = domains.length - shown.length;

  return (
    <section className="flex flex-wrap items-center gap-x-5 gap-y-4 rounded-2xl border border-border/70 bg-muted/20 px-5 py-4 transition-colors hover:border-border">
      <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-[#1F88C0]/12 text-[#1F88C0]">
        <SiCaddy className="size-6" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2">
          <span className="text-sm font-medium">{t('entry.title')}</span>
          <span
            className={cn('size-1.5 rounded-full', running ? 'bg-emerald-500' : 'bg-red-500')}
          />
          <span className="text-xs text-muted-foreground">
            {running ? t('entry.running') : status.installed ? t('entry.stopped') : t('entry.not_installed')}
          </span>
        </p>

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {shown.length === 0 ? (
            <span className="text-xs text-muted-foreground">{t('entry.no_sites')}</span>
          ) : (
            shown.map((addr) => {
              const url = siteUrl(addr);
              const label = (
                <>
                  {addr}
                  {url && <ExternalLink className="size-3 opacity-50" />}
                </>
              );
              const cls =
                'inline-flex max-w-[240px] items-center gap-1.5 truncate rounded-lg bg-background px-2 py-1 font-mono text-xs text-foreground/90 ring-1 ring-border/60';
              return url ? (
                <a
                  key={addr}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(cls, 'transition-colors hover:text-foreground hover:ring-foreground/30')}
                >
                  {label}
                </a>
              ) : (
                <span key={addr} className={cls}>
                  {label}
                </span>
              );
            })
          )}
          {rest > 0 && <span className="text-xs text-muted-foreground">+{rest}</span>}
        </div>
      </div>

      <Link
        to="/sites"
        className="group ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
      >
        {status.installed ? t('entry.manage') : t('entry.enable')}
        <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
      </Link>
    </section>
  );
}
