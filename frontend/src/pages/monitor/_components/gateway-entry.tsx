import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowRight, FileText, Globe, Server } from 'lucide-react';
import { Skeleton } from '../../../components/ui/skeleton';
import type { GatewayStatus, SiteEntry } from '../../sites/_api';
import { summarizeSite } from '../../sites/_lib/site-summary';
import { siteUrl } from '../../../lib/site-url';
import { cn } from '../../../lib/utils';
import { SectionTitle } from './section-title';

/**
 * 站点入口区块。
 *
 * 整块跟"应用与服务"用同一套骨架：标题 + 一行一行的条目，每条都是"图标 + 域名 +
 * 指向哪儿 + 开了什么"。原来那版是横跨整屏的一条大卡片，域名挤成小 chip —— 跟下面
 * 那排容器是两种语言，读起来像两个页面拼的。
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

  if (!status && !settled) {
    return (
      <section>
        <Skeleton className="h-5 w-24" />
        <div className="mt-6 grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-2xl" />
          ))}
        </div>
      </section>
    );
  }
  // 拉不到状态（接口挂了）就整块不显示，别把骨架留在页面上。
  if (!status) return null;

  const running = status.running;

  return (
    <section>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SectionTitle icon={Globe} title={t('entry.title')} />
        <span className={cn('size-1.5 rounded-full', running ? 'bg-emerald-500' : 'bg-red-500')} />
        <span className="text-xs text-muted-foreground">
          {running ? t('entry.running') : status.installed ? t('entry.stopped') : t('entry.not_installed')}
        </span>
        <Link
          to="/sites"
          className="group ml-auto inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          {status.installed ? t('entry.manage') : t('entry.enable')}
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
        {sites.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('entry.no_sites')}</p>
        ) : (
          sites.map((site) => <SiteEntryItem key={site.addr} site={site} />)
        )}
      </div>
    </section>
  );
}

/** 一条入口，解剖结构跟容器那条对齐：图标 + 名字 + 两行说明。 */
function SiteEntryItem({ site }: { site: SiteEntry }) {
  const { t } = useTranslation();
  const info = summarizeSite(site);
  const Icon = info.kind === 'static' ? FileText : Server;
  const url = siteUrl(site.addr);

  const body = (
    <>
      <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-sky-500/10 text-sky-600 dark:text-sky-400">
        <Icon className="size-6" />
      </span>
      <div className="min-w-0 flex-1 text-left">
        <p className="truncate font-mono text-sm">{site.addr}</p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {info.kind === 'other'
            ? t('sites.kind_other')
            : `${t(`sites.kind_${info.kind}`)}${info.target ? ` → ${info.target}` : ''}`}
        </p>
        {info.features.length > 0 && (
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground/80">
            {info.features.map((f) => t(`sites.feature_${f}`)).join(' · ')}
          </p>
        )}
      </div>
    </>
  );

  // 和容器那条一样：悬停底色要留出内边距（p-2 + -m-2），贴边不好看。
  const cls =
    '-m-2 flex min-w-0 items-center gap-3.5 rounded-2xl p-2 transition-colors hover:bg-muted/40';
  // 域名能直接打开就外链，否则（`:443`、通配）去站点管理页 —— 两种都只渲染一个
  // 可点元素，不套娃。
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className={cls}>
      {body}
    </a>
  ) : (
    <Link to="/sites" className={cls}>
      {body}
    </Link>
  );
}
