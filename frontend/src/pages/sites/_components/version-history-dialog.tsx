import { useTranslation } from 'react-i18next';
import { History, RotateCcw } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../../components/ui/dialog';
import { Skeleton } from '../../../components/ui/skeleton';
import type { CaddyfileVersion } from '../_api';

/** 把 SQLite 里的 `2026-10-06 03:12:44` 显示成好读的样子。 */
function formatTime(raw: string): string {
  const d = new Date(raw.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return raw;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function VersionHistoryDialog({
  versions,
  loading,
  onOpen,
  onRestore,
}: {
  versions: CaddyfileVersion[];
  loading: boolean;
  onOpen: () => void;
  onRestore: (id: number) => void;
}) {
  const { t } = useTranslation();

  return (
    <Dialog onOpenChange={(open) => open && onOpen()}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <History />
          {t('sites.history')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('sites.history')}</DialogTitle>
          <DialogDescription>{t('sites.history_desc')}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] space-y-2 overflow-y-auto py-2">
          {loading && versions.length === 0 ? (
            Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)
          ) : versions.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('sites.history_empty')}</p>
          ) : (
            versions.map((v) => (
              <div
                key={v.id}
                className="flex items-center gap-3 rounded-xl border border-border/60 px-3.5 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm tabular-nums">{formatTime(v.created_at)}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {v.author || t('sites.history_unknown_author')}
                    {v.note ? ` · ${v.note}` : ''} · {(v.size / 1024).toFixed(1)} KB
                  </p>
                </div>
                <Button variant="secondary" size="sm" onClick={() => onRestore(v.id)}>
                  <RotateCcw />
                  {t('sites.restore')}
                </Button>
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          <p className="mr-auto text-xs text-muted-foreground">{t('sites.history_hint')}</p>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
