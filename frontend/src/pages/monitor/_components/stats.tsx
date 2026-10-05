import { useTranslation } from 'react-i18next';
import type { SysInfo } from '../_api';
import { formatBytes } from '../_hooks/use-monitor';
import { ringTone } from './ring';
import { cn } from '../../../lib/utils';

/** 跟圆环同一套配色：同一份数据不管用哪种形状画，颜色含义得一致。 */
const TONE_FILL = {
  ok: 'bg-foreground/70',
  warn: 'bg-amber-500',
  danger: 'bg-red-500',
} as const;

export type StatsProps = {
  sys: SysInfo;
  diskPct: number;
  diskSub: string;
  loadPct: number;
  swapPct: number;
};

/**
 * 横向柱状的系统占用。
 *
 * 圆环看的是"单项到没到警戒线"，柱子看的是"几项之间谁更紧张" —— 五条横杠左对齐排
 * 在一起时，长短差一眼就能比出来，而五个环要一个个读数字。所以两种都留着：
 * 环放细节（核数、容量），柱放对比。
 */
export function Stats({ sys, diskPct, diskSub, loadPct, swapPct }: StatsProps) {
  const { t } = useTranslation();

  const rows = [
    { key: 'cpu', label: t('monitor.cpu'), value: sys.cpu_usage, sub: `${sys.cpu_cores} ${t('monitor.cores')}` },
    { key: 'load', label: t('monitor.load'), value: loadPct, sub: sys.load_avg.map((n) => n.toFixed(1)).join(' / ') },
    { key: 'mem', label: t('monitor.memory'), value: sys.memory_percent, sub: `${formatBytes(sys.memory_used)} / ${formatBytes(sys.memory_total)}` },
    { key: 'disk', label: t('monitor.disk'), value: diskPct, sub: diskSub },
    { key: 'swap', label: t('monitor.swap'), value: swapPct, sub: sys.swap_total > 0 ? `${formatBytes(sys.swap_used)} / ${formatBytes(sys.swap_total)}` : '—' },
  ];

  return (
    <div className="flex flex-1 flex-col justify-center gap-3">
      {rows.map((r) => {
        const pct = Math.max(0, Math.min(100, Number.isFinite(r.value) ? r.value : 0));
        return (
          <div key={r.key} className="space-y-1.5">
            <div className="flex items-baseline gap-2 text-xs">
              <span className="w-10 shrink-0 font-medium">{r.label}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.sub}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {Math.round(pct)}%
              </span>
            </div>
            {/* 轨道用 muted、填充按档位换色，跟圆环同一套判断（ringTone）。 */}
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full rounded-full transition-[width] duration-700 ease-out', TONE_FILL[ringTone(pct)])}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
