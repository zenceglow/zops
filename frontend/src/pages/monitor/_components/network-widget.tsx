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
 *
 * 不套卡片：它跟问候语同处顶部一行，加个边框盒子会把这块切成"又一张卡片"，
 * 而桌面上应该是内容直接落在背景上。高度固定 188px，和左列对齐。
 */
export function NetworkWidget() {
  const { t } = useTranslation();
  const net = useNetworkRate();

  return (
    <Link
      to="/system/network"
      className="group flex h-[188px] w-full flex-col justify-between sm:w-[400px]"
    >
      {/* 走势紧挨在 chevron 左边同一行：它表达的是"此刻在怎么变"，
          和标题同级，而不是压在底部当配图。 */}
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-xs font-medium text-muted-foreground">
          {t('monitor.network')}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
            <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
          </span>
          {t('net.realtime')}
        </span>
        <NetworkSparkline
          history={net?.history ?? []}
          height={40}
          className="min-w-0 flex-1"
        />
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </div>

      <div className="flex items-end justify-between gap-4">
        <div className="flex shrink-0 items-end gap-6">
          <div className="whitespace-nowrap">
            <div className="text-base font-semibold leading-none tabular-nums">
              {net ? formatRate(net.rxRate) : '—'}
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">↓ {t('net.down')}</div>
          </div>
          <div className="whitespace-nowrap">
            <div className="text-base font-semibold leading-none tabular-nums">
              {net ? formatRate(net.txRate) : '—'}
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">↑ {t('net.up')}</div>
          </div>
        </div>
        <div className="min-w-0 text-right text-[10px] leading-relaxed text-muted-foreground">
          {net && (
            <>
              <div className="whitespace-nowrap">
                {net.ifaces.length} {t('net.iface')}
              </div>
              <div className="whitespace-nowrap tabular-nums">
                {t('net.total')} ↓{formatBytes(net.rxTotal)} ↑{formatBytes(net.txTotal)}
              </div>
            </>
          )}
        </div>
      </div>
    </Link>
  );
}
