import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import type { SysInfo } from '../_api';
import { computeHealthScore } from '../_lib/health-score';
import { cn } from '../../../lib/utils';
import { CleanupDialog } from './cleanup-dialog';

const TONE = {
  good: 'text-emerald-600 dark:text-emerald-400',
  fair: 'text-amber-600 dark:text-amber-400',
  poor: 'text-red-600 dark:text-red-400',
} as const;

const BAR = {
  good: 'bg-emerald-500',
  fair: 'bg-amber-500',
  poor: 'bg-red-500',
} as const;

/**
 * 服务器运行评分。
 *
 * 把五个指标压成一个数是为了"一眼知好坏"，但**必须同时给出扣在哪里** —— 只说
 * "78 分"没法行动，说"磁盘 92% 扣了 25 分"才知道该干什么。所以下面永远列着扣分项。
 *
 * 右边两个入口是运维动作：清垃圾、补漏洞。它们放在这儿是因为……看到分数低的时候，
 * 人正好处在"想干点什么"的状态。
 */
export function ServerScore({
  sys,
  diskPct,
  loadPct,
  swapPct,
}: {
  sys: SysInfo;
  diskPct: number;
  loadPct: number;
  swapPct: number;
}) {
  const { t } = useTranslation();
  const health = computeHealthScore({
    cpu: sys.cpu_usage,
    loadPct,
    memory: sys.memory_percent,
    disk: diskPct,
    swap: swapPct,
  });

  return (
    <div className="flex flex-col rounded-2xl border border-border/60 px-4 py-4">
      <p className="text-sm font-medium">{t('home.score')}</p>

      <div className="mt-3 flex items-baseline gap-2">
        <span className={cn('text-4xl font-semibold tabular-nums', TONE[health.grade])}>
          {health.score}
        </span>
        <span className="text-xs text-muted-foreground">{t('home.score_unit')}</span>
        <span className={cn('ml-auto text-sm', TONE[health.grade])}>
          {t(`home.score_${health.grade}`)}
        </span>
      </div>

      <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-[width] duration-700 ease-out', BAR[health.grade])}
          style={{ width: `${health.score}%` }}
        />
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        {health.deductions.length === 0
          ? t('home.score_clean')
          : health.deductions
              .map((d) => `${t(`home.metric_${d.key}`)} ${Math.round(d.value)}% −${d.points}`)
              .join(' · ')}
      </p>

      <div className="mt-auto flex gap-2 pt-4">
        <CleanupDialog />
        <Link
          to="/system/updates"
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-border/70 px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
        >
          <ShieldCheck className="size-3.5" />
          {t('home.patch')}
        </Link>
      </div>
    </div>
  );
}
