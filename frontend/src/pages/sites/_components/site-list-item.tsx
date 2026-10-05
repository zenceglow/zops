import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ExternalLink, FileText, Globe, Server } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { cn } from '../../../lib/utils';
import type { SiteEntry } from '../_api';
import { summarizeSite, type SiteFeature } from '../_lib/site-summary';
import { DirectiveRow } from './directive-row';

const KIND_ICON = { proxy: Server, static: FileText, other: Globe } as const;

/**
 * 站点列表里的一行 = 一个入口。
 *
 * 第一行回答"这个域名是什么、指向哪儿"，第二行是它开了哪些能力，指令树折叠在
 * "详情"里给需要的人看 —— 默认摊开成配置树，非技术用户根本读不出来这是个入口。
 */
export function SiteListItem({ site }: { site: SiteEntry }) {
  const { t } = useTranslation();
  const [showDetail, setShowDetail] = useState(false);
  const info = summarizeSite(site);
  const Icon = KIND_ICON[info.kind];

  return (
    <div className="rounded-2xl border border-border/60 px-4 py-3.5 transition-colors hover:border-border">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-xl',
            info.kind === 'proxy' ? 'bg-sky-500/10 text-sky-600 dark:text-sky-400' : 'bg-muted text-muted-foreground',
          )}
        >
          <Icon className="size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-sm font-medium">{site.addr}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {info.kind === 'other'
              ? t('sites.kind_other')
              : `${t(`sites.kind_${info.kind}`)}${info.target ? ` → ${info.target}` : ''}`}
          </p>
        </div>

        {info.url && (
          <a href={info.url} target="_blank" rel="noreferrer">
            <Button variant="outline" size="sm">
              <ExternalLink />
              {t('sites.open')}
            </Button>
          </a>
        )}
        <Button variant="ghost" size="sm" onClick={() => setShowDetail((v) => !v)}>
          {t('sites.detail')}
          <ChevronDown className={cn('size-3.5 transition-transform', showDetail && 'rotate-180')} />
        </Button>
      </div>

      {info.features.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5 pl-13">
          {info.features.map((f: SiteFeature) => (
            <span
              key={f}
              className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {t(`sites.feature_${f}`)}
            </span>
          ))}
        </div>
      )}

      {showDetail && (
        <div className="mt-3 divide-y rounded-xl border border-border/60">
          {site.directives.length === 0 ? (
            <div className="px-4 py-3 text-xs text-muted-foreground">—</div>
          ) : (
            site.directives.map((d, i) => <DirectiveRow key={i} directive={d} />)
          )}
        </div>
      )}
    </div>
  );
}
