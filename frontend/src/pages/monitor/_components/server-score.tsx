import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import type { SysInfo } from '../_api';
import { computeHealthScore } from '../_lib/health-score';
import { cn } from '../../../lib/utils';
import { CleanupDialog } from './cleanup-dialog';
import { Ring } from './ring';

/** 评分越高越好，所以档位色是反着给的（见 Ring 的 tone 参数）。 */
const GRADE_TONE = { good: 'ok', fair: 'warn', poor: 'danger' } as const;

/**
 * 服务器运行评分。
 *
 * 用粗圆环而不是进度条：这是"一眼知好坏"的东西，形状本身就该有分量感。环里放
 * 分数、环下放档位（良好/一般/需要注意），旁边列**扣在哪里** —— 只给一个分数
 * 没法行动，说"安全补丁 4 个扣了 8 分"才知道该干什么。
 *
 * 扣分项里有一类是补丁：它不是"占用"而是"风险"，由后台定期检查后算进来。
 */
export function ServerScore({
  sys,
  diskPct,
  loadPct,
  swapPct,
  security,
}: {
  sys: SysInfo;
  diskPct: number;
  loadPct: number;
  swapPct: number;
  security: number;
}) {
  const { t } = useTranslation();
  const health = computeHealthScore({
    cpu: sys.cpu_usage,
    loadPct,
    memory: sys.memory_percent,
    disk: diskPct,
    swap: swapPct,
    security,
  });

  return (
    <div className="flex flex-col rounded-2xl border border-border/60 px-4 py-4">
      <p className="text-sm font-medium">{t('home.score')}</p>

      <div className="mt-3 flex items-center gap-5">
        <Ring
          value={health.score}
          label=""
          size={132}
          thickness={13}
          unit={t('home.score_unit')}
          tone={GRADE_TONE[health.grade]}
        />

        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'text-sm font-medium',
              health.grade === 'good'
                ? 'text-emerald-600 dark:text-emerald-400'
                : health.grade === 'fair'
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-red-600 dark:text-red-400',
            )}
          >
            {t(`home.score_${health.grade}`)}
          </p>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {health.deductions.length === 0 ? (
              <li>{t('home.score_clean')}</li>
            ) : (
              health.deductions.map((d) => (
                <li key={d.key} className="truncate">
                  {t(`home.metric_${d.key}`)}{' '}
                  {/* 补丁的 value 是"个数"，占用类的是百分比，单位不能混。 */}
                  {d.key === 'security' ? d.value : `${Math.round(d.value)}%`}
                  <span className="ml-1.5 text-foreground/70">−{d.points}</span>
                </li>
              ))
            )}
          </ul>
        </div>
      </div>

      <div className="mt-auto flex gap-2 pt-4">
        <CleanupDialog />
        <Link
          to="/system/updates"
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-border/70 px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
        >
          <ShieldCheck className="size-3.5" />
          {t('home.patch')}
          {security > 0 && (
            <span className="rounded-md bg-amber-500/15 px-1.5 text-[10px] text-amber-600 dark:text-amber-400">
              {security}
            </span>
          )}
        </Link>
      </div>
    </div>
  );
}
