import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { NetworkSparkline } from '../../../components/network-sparkline';
import { formatRate, useNetworkRate } from '../../../hooks/use-network-rate';
import { formatBytes } from '../_hooks/use-monitor';

/**
 * 首页的网络挂件：一个统计 + 一段实时速率。
 *
 * 明细（每张网卡、累计流量）在 /system/network，点这里进去看 —— 首页只负责
 * 回答"现在网络忙不忙"，不负责把所有列都摊开。
 */
export function NetworkWidget() {
  const { t } = useTranslation();
  const net = useNetworkRate();

  return (
    <Link
      to="/system/network"
      className="group mx-auto block w-full max-w-2xl rounded-2xl border border-border/60 bg-card/40 px-5 py-4 transition-colors hover:border-border hover:bg-card/70"
    >
      <div className="flex items-center gap-3">
        <span className="text-xs font-medium text-muted-foreground">{t('monitor.network')}</span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
            <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
          </span>
          {t('net.realtime')}
        </span>
        <ChevronRight className="ml-auto size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </div>

      <div className="mt-3 flex items-end gap-8">
        <div>
          <div className="text-2xl font-semibold leading-none tabular-nums">
            {net ? formatRate(net.rxRate) : '—'}
          </div>
          <div className="mt-1.5 text-xs text-muted-foreground">↓ {t('net.down')}</div>
        </div>
        <div>
          <div className="text-2xl font-semibold leading-none tabular-nums">
            {net ? formatRate(net.txRate) : '—'}
          </div>
          <div className="mt-1.5 text-xs text-muted-foreground">↑ {t('net.up')}</div>
        </div>
        <div className="ml-auto text-right text-xs leading-relaxed text-muted-foreground">
          {net && (
            <>
              <div>
                {net.ifaces.length} {t('net.iface')}
              </div>
              <div className="tabular-nums">
                {t('net.total')} ↓ {formatBytes(net.rxTotal)} · ↑ {formatBytes(net.txTotal)}
              </div>
            </>
          )}
        </div>
      </div>

      <NetworkSparkline history={net?.history ?? []} className="mt-4" />
    </Link>
  );
}
