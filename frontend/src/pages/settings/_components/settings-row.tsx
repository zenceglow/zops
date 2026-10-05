import type { ComponentType, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../../lib/utils';

/**
 * 设置项的一行：图标 + 名称 + 一句话说明 + 箭头。
 *
 * `to` 和 `onClick` 二选一，只渲染一个可点元素 —— 套娃的可点区域键盘和读屏都难用。
 */
export function SettingsRow({
  icon: Icon,
  label,
  desc,
  to,
  href,
  onClick,
  trailing,
  danger,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  desc?: string;
  to?: string;
  /** 外链。和 `to` 一样是二选一，只渲染一个可点元素。 */
  href?: string;
  onClick?: () => void;
  trailing?: ReactNode;
  danger?: boolean;
}) {
  const cls = cn(
    'flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors',
    danger ? 'hover:bg-destructive/10' : 'hover:bg-muted/50',
  );
  const body = (
    <>
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl',
          danger ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-sm font-medium', danger && 'text-destructive')}>
          {label}
        </span>
        {desc && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{desc}</span>}
      </span>
      {trailing}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
    </>
  );

  if (to) {
    return (
      <Link to={to} className={cls}>
        {body}
      </Link>
    );
  }
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {body}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {body}
    </button>
  );
}
