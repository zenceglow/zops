import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card';

export function PagePlaceholder({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <Icon className="size-8 mb-3 opacity-40" />
        <p className="text-sm">{title}</p>
        {description && (
          <p className="text-xs mt-2 text-muted-foreground/70 max-w-sm text-center">
            {description}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
