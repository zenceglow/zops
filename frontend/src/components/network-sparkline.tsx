import { cn } from '../lib/utils';

const W = 240;
const H = 44;

/**
 * 网络速率走势。
 *
 * 用两条简单折线而不是图表库：这里要的是"现在是在涨还是在平"，不是可交互的
 * 数据探索，引一个图表库不值得。
 */
export function NetworkSparkline({
  history,
  className,
}: {
  history: { rx: number; tx: number }[];
  className?: string;
}) {
  const n = history.length;
  const ready = n >= 2;
  // 共用一个峰值：两条线各自归一化的话，谁大谁小就看不出来了。
  const max = Math.max(1, ...history.flatMap((p) => [p.rx, p.tx]));

  const path = (key: 'rx' | 'tx') =>
    history
      .map((p, i) => {
        const x = (i / (n - 1)) * W;
        const y = H - Math.min(p[key] / max, 1) * (H - 2) - 1;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');

  return (
    <div className={cn('relative', className)} style={{ height: H }}>
      {ready ? (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="h-full w-full"
          aria-hidden
        >
          <path d={path('rx')} fill="none" strokeWidth={2} className="stroke-primary" vectorEffect="non-scaling-stroke" />
          <path
            d={path('tx')}
            fill="none"
            strokeWidth={1.5}
            className="stroke-muted-foreground/60"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : (
        <div className="h-full w-full rounded-md bg-muted/30" />
      )}
    </div>
  );
}
