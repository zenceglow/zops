import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RollingNumber } from '../../../components/rolling-number';
import { cn } from '../../../lib/utils';

export interface PressureMetric {
  key: string;
  /** 已经算成百分比的占用。可能超过 100（负载在核数不够时会）。 */
  value: number;
  /** 一行小字，说清楚这个数是从哪来的。 */
  detail?: string;
}

const SEGMENTS = 20;

/**
 * 峰值保持。
 *
 * 只显示当前值的话，一次尖峰刷过去就没了；只显示峰值的话，早就恢复的机器会一直
 * 看起来在告急。所以峰值"涨立刻跟、跌慢慢落" —— 仪表盘上的最大值指针就是这么
 * 干的，一眼能看出刚才有没有冲高。
 */
function usePeak(value: number, decay = 8) {
  const [peak, setPeak] = useState(value);
  useEffect(() => {
    setPeak((prev) => Math.max(value, prev - decay));
  }, [value, decay]);
  return peak;
}

function toneOf(pct: number): { on: string; text: string } {
  if (pct >= 90) return { on: 'bg-red-500', text: 'text-red-400' };
  if (pct >= 75) return { on: 'bg-amber-400', text: 'text-amber-300' };
  return { on: 'bg-emerald-400', text: 'text-emerald-300' };
}

/**
 * 一格一格的 LED 条。
 *
 * 用分段而不是连续进度条：段的明灭本身就是"读数"，像老式仪表的灯排，扫一眼能数
 * 出大概到了第几格，连续条只能看个大概。每段给一点递进的 delay，涨上去时是从
 * 左往右亮起来的，而不是整条一起变。
 */
function LedMeter({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const lit = Math.round((pct / 100) * SEGMENTS);
  const peak = usePeak(value);
  const peakIdx = Math.min(SEGMENTS - 1, Math.round((Math.min(100, peak) / 100) * SEGMENTS) - 1);
  const tone = toneOf(value);
  const alarmed = value >= 90;

  return (
    <div className="relative flex gap-[3px]">
      {Array.from({ length: SEGMENTS }).map((_, i) => {
        const on = i < lit;
        return (
          <span
            key={i}
            style={{ transitionDelay: `${i * 14}ms` }}
            className={cn(
              'h-3 flex-1 rounded-[2px] transition-colors duration-500',
              on ? tone.on : 'bg-white/10',
              // 告急的格子呼吸。整条一起闪会变成噪音，看不出是哪一项在报警。
              on && alarmed && 'gauge-alarm',
              // 峰值指针：比当前值高出来的那一格描个边。
              i === peakIdx && peakIdx >= lit && 'bg-white/25 ring-1 ring-white/60',
            )}
          />
        );
      })}
    </div>
  );
}

/**
 * 服务器压力检测仪。
 *
 * 压力指数取**最紧张的那一项**，不是平均值：机器被拖垮从来是被某一项先拖垮的
 * ——盘写满、Swap 打满、负载压过核数——平均一下反而把最要命的那根木头藏起来了。
 * 所以指数下面直接点名是谁在顶着。
 */
export function PressurePanel({
  metrics,
  processes,
}: {
  metrics: PressureMetric[];
  processes?: number;
}) {
  const { t } = useTranslation();
  const worst = metrics.reduce((a, b) => (b.value > a.value ? b : a), metrics[0]);
  const index = Math.min(100, Math.round(worst?.value ?? 0));
  const tone = toneOf(worst?.value ?? 0);
  const level =
    (worst?.value ?? 0) >= 90
      ? t('screen.pressure_high')
      : (worst?.value ?? 0) >= 75
        ? t('screen.pressure_mid')
        : t('screen.pressure_low');

  return (
    <div className="rounded-xl bg-white/[0.03] px-3.5 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-[11px] text-zinc-500">{t('screen.pressure')}</p>
        <span className="flex items-baseline gap-1.5">
          <RollingNumber value={index} className={cn('text-2xl', tone.text)} />
          <span className={cn('text-[11px]', tone.text)}>{level}</span>
        </span>
        {worst && (
          <span className="text-[11px] text-zinc-500">
            {t('screen.pressure_bottleneck', { name: t(`screen.m_${worst.key}`) })}
          </span>
        )}
        {processes !== undefined && (
          <span className="ml-auto font-mono text-[11px] text-zinc-600">
            {t('screen.processes', { count: processes })}
          </span>
        )}
      </div>

      {/* 五个仪表横着排；窄屏折成两列，不至于把读数挤掉。 */}
      <div className="mt-2.5 grid grid-cols-2 gap-x-5 gap-y-2.5 lg:grid-cols-3 2xl:grid-cols-5">
        {metrics.map((m) => {
          const tone = toneOf(m.value);
          return (
            <div key={m.key} className="min-w-0">
              <div className="flex items-baseline gap-2 text-[11px]">
                <span className="text-zinc-400">{t(`screen.m_${m.key}`)}</span>
                <span className={cn('ml-auto font-mono tabular-nums', tone.text)}>
                  {m.value >= 10 ? Math.round(m.value) : m.value.toFixed(1)}%
                </span>
              </div>
              <div className="mt-1">
                <LedMeter value={m.value} />
              </div>
              {m.detail && (
                <p className="mt-1 truncate font-mono text-[10px] text-zinc-600" title={m.detail}>
                  {m.detail}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
