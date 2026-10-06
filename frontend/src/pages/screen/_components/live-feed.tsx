import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useScreenStore } from '../_store';
import type { AccessEvent } from '../_api';

const GRID = 'grid-cols-[64px_108px_1fr_1.5fr_52px_44px]';

function statusTone(status: number): string {
  if (status >= 500) return 'text-red-400';
  if (status >= 400) return 'text-amber-300';
  if (status >= 300) return 'text-sky-300';
  if (status >= 200) return 'text-emerald-300';
  return 'text-zinc-500';
}

/**
 * 一行流水。
 *
 * memo 是关键：这个列表每 3 秒接一批新行，而**老行的对象引用是不变的**（store
 * 里只往前接，不重建）。所以一次轮询真正重绘的只有新来的那几行，而不是四十行全
 * 重来 —— 大屏上"全量刷新"的闪烁观感就是从这儿来的。
 */
const EventRow = memo(function EventRow({ event }: { event: AccessEvent }) {
  const e = event;
  return (
    <div
      className={cn(
        'grid animate-in fade-in-0 slide-in-from-top-1 gap-2 border-b border-white/[0.04] py-[3px] font-mono text-[11px] duration-300',
        GRID,
        e.blocked ? 'bg-red-500/[0.07]' : e.bot && 'bg-amber-400/[0.05]',
      )}
    >
      <span className="text-zinc-500 tabular-nums">{e.time}</span>
      <span className="truncate text-zinc-300" title={`${e.location} ${e.isp} ${e.ip}`}>
        {e.location}
      </span>
      <span className="truncate text-zinc-500" title={e.host}>
        {e.host}
      </span>
      <span className="truncate text-zinc-200" title={`${e.uri}  —  ${e.ua}`}>
        {e.uri}
      </span>
      <span className="text-right text-zinc-500">{e.method}</span>
      <span className={cn('text-right tabular-nums', statusTone(e.status))}>{e.status}</span>
    </div>
  );
});

/**
 * 底部实时流水。
 *
 * 自带订阅：只有 events 变了才重绘这一块，时钟、系统指标、概览怎么变都跟它无关。
 */
export function LiveFeed() {
  const { t } = useTranslation();
  const events = useScreenStore((s) => s.events);

  return (
    <div className="relative z-10 mt-3 flex h-[30vh] min-h-[168px] shrink-0 flex-col border-t border-white/5 px-6 pt-2 pb-3">
      <div className="flex items-center gap-2 text-[11px]">
        <Activity className="size-3.5 text-emerald-400" />
        <span className="font-medium text-zinc-200">{t('screen.live_title')}</span>
        <span className="text-zinc-600">{t('screen.live_hint')}</span>
        <span className="ml-auto flex items-center gap-3 text-zinc-600">
          <Legend className="bg-amber-300" label={t('screen.legend_bot')} />
          <Legend className="bg-red-400" label={t('screen.legend_blocked')} />
        </span>
      </div>

      <div
        className={cn(
          'mt-1.5 grid shrink-0 gap-2 pb-1 text-[10px] tracking-wider text-zinc-600 uppercase',
          GRID,
        )}
      >
        <span>{t('screen.col_time')}</span>
        <span>{t('screen.col_location')}</span>
        <span>{t('screen.col_host')}</span>
        <span>{t('screen.col_uri')}</span>
        <span className="text-right">{t('screen.col_method')}</span>
        <span className="text-right">{t('screen.col_status')}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {events.length === 0 ? (
          <p className="py-4 text-center text-[11px] text-zinc-600">{t('screen.live_empty')}</p>
        ) : (
          events.map((e) => <EventRow key={e.id} event={e} />)
        )}
      </div>
    </div>
  );
}

export function Legend({
  className,
  label,
  square,
}: {
  className: string;
  label: string;
  square?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('size-1.5', square ? 'rounded-[1px]' : 'rounded-full', className)} />
      {label}
    </span>
  );
}
