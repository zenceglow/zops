import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowRight, ExternalLink } from 'lucide-react';
import { SiCaddy } from 'react-icons/si';
import { Skeleton } from '../../../components/ui/skeleton';
import { fetchGatewayConfig, fetchGatewayStatus } from '../../sites/_api';
import type { GatewayStatus, SiteEntry } from '../../sites/_api';
import { cn } from '../../../lib/utils';

/**
 * 站点地址 → 能点的 URL。
 *
 * Caddy 的地址写法很杂：`flashsync.cn`、`http://localhost:8080`、`:443`、`*.a.com`。
 * 只有前两种浏览器能直接打开；`:443` 是"本机所有网卡的这个端口"，`*.a.com` 是通配，
 * 都没有可访问的主机名，原样显示成文本就好。
 */
function siteUrl(addr: string): string | null {
  const head = addr.trim().split(/\s+/)[0];
  if (!head) return null;
  if (/^https?:\/\//i.test(head)) return head;
  if (head.startsWith(':') || head.includes('*')) return null;
  return `https://${head}`;
}

function useGatewayEntry() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [sites, setSites] = useState<SiteEntry[]>([]);
  // 请求结束（无论成败）后就不再显示骨架：否则网关没装/接口挂了会让首页永远挂着
  // 一个加载中的占位，比"这块没有"更让人困惑。
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    let alive = true;
    // 两个都失败也无所谓 —— 首页不该因为网关没装就整块崩掉。
    Promise.all([fetchGatewayStatus().catch(() => null), fetchGatewayConfig().catch(() => null)]).then(
      ([st, cfg]) => {
        if (!alive) return;
        setStatus(st);
        setSites(cfg?.parsed.sites ?? []);
        setSettled(true);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  return { status, sites, settled };
}

/**
 * 首页的站点入口。
 *
 * 刻意跟容器那排不一样：那是"机器上跑着什么"，这是"外面的人从哪儿进来"。所以给它
 * 卡片壳、品牌色图标和明确的箭头 —— 一排图标里混着它的话，看不出这是个门。
 */
export function GatewayEntry() {
  const { t } = useTranslation();
  const { status, sites, settled } = useGatewayEntry();

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
