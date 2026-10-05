import { cn } from '../../../lib/utils';

/**
 * 粗环仪表。
 *
 * 刻意不用进度条 + 大数字的卡片：环是"这台机器现在的状态"最直观的形状，
 * 一眼扫过去就知道哪一项在告急，不需要先读数字再换算比例。
 *
 * 配色只在真的偏高时才变：#75 以下保持中性色，超过才转琥珀 / 红，
 * 免得四个环都花花绿绿反而看不出重点。
 */
export function ringTone(percent: number): 'ok' | 'warn' | 'danger' {
  if (percent >= 90) return 'danger';
  if (percent >= 75) return 'warn';
  return 'ok';
}

const TONE_STROKE = {
  ok: 'stroke-primary',
  warn: 'stroke-amber-500',
  // 固定用 red-500 而不是主题的 destructive：暗色主题里 destructive 偏砖红，
  // "告急"这一档需要跨明暗都一眼跳出来。
  danger: 'stroke-red-500',
} as const;

export function Ring({
  value,
  label,
  sub,
  size = 148,
  thickness = 14,
}: {
  value: number;
  label: string;
  sub?: string;
  size?: number;
  thickness?: number;
}) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const r = (size - thickness) / 2;
  const circumference = 2 * Math.PI * r;
  const tone = ringTone(pct);

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="-rotate-90"
          role="img"
          aria-label={`${label} ${Math.round(pct)}%`}
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={thickness}
            className="stroke-muted"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={thickness}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - pct / 100)}
            className={cn(TONE_STROKE[tone], 'transition-[stroke-dashoffset] duration-700 ease-out')}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-[2rem] font-semibold leading-none tabular-nums">
            {Math.round(pct)}
            <span className="ml-0.5 align-baseline text-sm font-normal text-muted-foreground">%</span>
          </span>
        </div>
      </div>
      <div className="text-center">
        <p className="text-sm font-medium">{label}</p>
        {sub && <p className="mt-1 text-xs text-muted-foreground tabular-nums">{sub}</p>}
      </div>
    </div>
  );
}
