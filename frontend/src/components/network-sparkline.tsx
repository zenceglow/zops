import { cn } from '../lib/utils';
import { NET_HISTORY_SIZE } from '../hooks/use-network-rate';

const W = 240;
/** x 轴上固定的刻度数：不管有几个采样点，横轴都被切成同样多的段。 */
const TICKS = 6;
/** 底部留给刻度的横轴带高度（px）。 */
const AXIS_H = 6;

/**
 * 网络速率走势。
 *
 * 用两条简单折线而不是图表库：这里要的是"现在是在涨还是在平"，不是可交互的
 * 数据探索，引一个图表库不值得。
 *
 * 横轴是**固定槽位**的：x 由容量决定，而不是由当前点数决定。否则刚打开页面
 * 只有两个点时，这两点会被铺满整条宽度，看起来像"整个窗口都是这条线"，把
 * "刚开始采样"误读成"网络一直是这样"。点不够时右边先长，左边留白。
 */
export function NetworkSparkline({
  history,
  className,
  height = 44,
  capacity = NET_HISTORY_SIZE,
}: {
  history: { rx: number; tx: number }[];
  className?: string;
  height?: number;
  /** x 轴槽位总数，应与采样缓冲的长度一致。 */
  capacity?: number;
}) {
  const H = height;
  const plotH = Math.max(4, H - AXIS_H);
  const n = history.length;
  const ready = n >= 2;
  const cap = Math.max(capacity, 2);
  const offset = Math.max(0, cap - n);
  // 共用一个峰值：两条线各自归一化的话，谁大谁小就看不出来了。
  const max = Math.max(1, ...history.flatMap((p) => [p.rx, p.tx]));

  const x = (i: number) => ((offset + i) / (cap - 1)) * W;

  const path = (key: 'rx' | 'tx') =>
    history
      .map((p, i) => {
        const y = plotH - Math.min(p[key] / max, 1) * (plotH - 2) - 1;
        return `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');

  return (
    <div className={cn('relative', className)} style={{ height: H }}>
      {/* 固定横轴：底边 + 等距刻度，点少的时候也看得出"这才刚开始"。 */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
        aria-hidden
      >
        <line
          x1={0}
          y1={plotH + 0.5}
          x2={W}
          y2={plotH + 0.5}
          strokeWidth={1}
          className="stroke-muted-foreground/20"
          vectorEffect="non-scaling-stroke"
        />
        {Array.from({ length: TICKS }, (_, i) => {
          const tx = (i / (TICKS - 1)) * W;
          return (
            <line
              key={i}
              x1={tx}
              y1={plotH + 1}
              x2={tx}
              y2={H}
              strokeWidth={1}
              className="stroke-muted-foreground/30"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      {ready ? (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
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
        <div className="absolute inset-x-0 top-0 rounded-md bg-muted/20" style={{ height: plotH }} />
      )}
    </div>
  );
}
