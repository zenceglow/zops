import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, Mail, Scale, Server, Clock } from 'lucide-react';
import { BrandLogo } from '../../components/brand-logo';
import { get } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { toast } from '../../components/ui/sonner';

type PanelInfo = {
  name: string;
  version: string;
  github: string;
  email: string;
  uptime_seconds: number;
};

/** 秒 → "3 天 4 小时" 这种人话。关于页不需要精确到秒。 */
function humanUptime(seconds: number, t: (k: string, o?: Record<string, unknown>) => string) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return t('about.uptime_dh', { d: days, h: hours });
  if (hours > 0) return t('about.uptime_hm', { h: hours, m: mins });
  return t('about.uptime_m', { m: mins });
}

/**
 * 关于页。从顶部菜单栏的 logo 点进来。
 *
 * 放的是"这软件是什么、出问题去哪儿说"：版本、简介、开源仓库、联系邮箱。
 * 版本号由后端给 —— 前端写死的版本号迟早和后端对不上，那种不一致比没有更糟。
 */
export default function AboutPage() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<PanelInfo | null>(null);

  useEffect(() => {
    void get<PanelInfo>('/system/panel')
      .then((res) => {
        if (res.success && res.data) setInfo(res.data);
      })
      .catch(() => {});
  }, []);

  const copyEmail = async () => {
    if (await copyText(info?.email ?? '')) toast.success(t('about.email_copied'));
  };

  return (
    <div className="mx-auto max-w-3xl space-y-8 py-4">
      <div className="flex flex-col items-center gap-4 text-center">
        <BrandLogo className="size-20" />
        <div>
          <h1 className="text-3xl font-bold tracking-tight">ZOPS</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">{t('about.tagline')}</p>
        </div>
        <span className="rounded-full border border-border/60 px-3 py-1 font-mono text-xs text-muted-foreground">
          {t('about.version')} {info?.version ?? '—'}
        </span>
      </div>

      <p className="text-center text-sm leading-7 text-muted-foreground">{t('about.intro')}</p>

      <div className="grid gap-3 sm:grid-cols-3">
        <InfoCell icon={Server} label={t('about.version')} value={info?.version ?? '—'} />
        <InfoCell
          icon={Clock}
          label={t('about.uptime')}
          value={info ? humanUptime(info.uptime_seconds, t) : '—'}
        />
        <InfoCell icon={Scale} label={t('about.license')} value="MIT" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <a
          href={info?.github ?? '#'}
          target="_blank"
          rel="noreferrer"
          className="group flex items-center gap-3 rounded-2xl border border-border/60 px-4 py-3.5 transition-colors hover:border-border hover:bg-muted/40"
        >
          <GitHubMark />
          <span className="min-w-0">
            <span className="block text-xs text-muted-foreground">{t('about.github')}</span>
            <span className="block truncate font-mono text-sm">{info?.github ?? '—'}</span>
          </span>
          <ArrowUpRight className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </a>

        <button
          type="button"
          onClick={copyEmail}
          className="group flex items-center gap-3 rounded-2xl border border-border/60 px-4 py-3.5 text-left transition-colors hover:border-border hover:bg-muted/40"
        >
          <Mail className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block text-xs text-muted-foreground">{t('about.contact')}</span>
            <span className="block truncate font-mono text-sm">{info?.email ?? '—'}</span>
          </span>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
            {t('about.copy')}
          </span>
        </button>
      </div>

      <p className="text-center text-xs leading-6 text-muted-foreground">{t('about.footer')}</p>
    </div>
  );
}

function InfoCell({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Server;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-border/60 px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <p className="mt-1 font-mono text-sm">{value}</p>
    </div>
  );
}

/** GitHub 的标记。图标库里没有它，画一个比引一个图标包值。 */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0 fill-current" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
