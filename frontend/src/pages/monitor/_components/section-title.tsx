import type { ComponentType } from 'react';

export function SectionTitle({
  icon: Icon,
  title,
  hint,
}: {
  // 不限死 lucide：品牌图标（react-icons）也要能用。
  icon: ComponentType<{ className?: string }>;
  title: string;
  /** 标题右边的补充说明，可省。 */
  hint?: string;
}) {
  return (
    <h2 className="flex items-center gap-2 text-base font-semibold">
      <Icon className="size-4 text-muted-foreground" />
      {title}
      {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
    </h2>
  );
}
