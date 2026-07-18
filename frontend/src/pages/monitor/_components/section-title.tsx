import type { LucideIcon } from 'lucide-react';

export function SectionTitle({
  icon: Icon,
  title,
}: {
  icon: LucideIcon;
  title: string;
}) {
  return (
    <h2 className="flex items-center gap-2 text-base font-semibold">
      <Icon className="size-4 text-muted-foreground" />
      {title}
    </h2>
  );
}
