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
      className="group flex w-full flex-col gap-4 sm:w-[400px]"
    >
      {/* Row：左列上下行竖排，右侧走势占满剩余宽度 */}
      <div className="flex items-center gap-5">
        <div className="flex shrink-0 flex-col gap-2">
          <div className="flex items-baseline gap-2 whitespace-nowrap">
            <span className="w-8 text-[10px] text-muted-foreground">↑ {t('net.up')}</span>
            <span className="text-base font-semibold leading-none tabular-nums">
              {net ? formatRate(net.txRate) : '—'}
            </span>
          </div>
          <div className="flex items-baseline gap-2 whitespace-nowrap">
            <span className="w-8 text-[10px] text-muted-foreground">↓ {t('net.down')}</span>
            <span className="text-base font-semibold leading-none tabular-nums">
              {net ? formatRate(net.rxRate) : '—'}
            </span>
          </div>
        </div>
        <NetworkSparkline
          history={net?.history ?? []}
          height={56}
          className="min-w-0 flex-1"
        />
      </div>

      {/* Row：网卡数量 · 累计流量 · chevron */}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        {net && (
          <>
            <span className="whitespace-nowrap">
              {net.ifaces.length} {t('net.iface')}
            </span>
            <span className="opacity-40">·</span>
            <span className="whitespace-nowrap tabular-nums">
              {t('net.total')} ↓{formatBytes(net.rxTotal)} ↑{formatBytes(net.txTotal)}
            </span>
          </>
        )}
        <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}
