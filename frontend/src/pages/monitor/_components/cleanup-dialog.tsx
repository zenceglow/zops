import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
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
import { cn } from '../../../lib/utils';
import { pruneJunk } from '../../docker/containers/_api';

type Choice = 'images' | 'containers' | 'networks';

/** 字节 → 人读的大小。清理结果要能说出"释放了多少"，不然等于没说。 */
function human(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  if (bytes >= 1 << 20) return `${Math.round(bytes / (1 << 20))} MB`;
  if (bytes >= 1 << 10) return `${Math.round(bytes / (1 << 10))} KB`;
  return `${bytes} B`;
}

const OPTIONS: { key: Choice; labelKey: string }[] = [
  { key: 'images', labelKey: 'junk_images' },
  { key: 'containers', labelKey: 'junk_containers' },
  { key: 'networks', labelKey: 'junk_networks' },
];

/**
 * 垃圾清理。
 *
 * 清什么由用户勾 —— 不提供"一键全清"，因为"占用空间"和"能删"是两回事：正在跑的
 * 镜像、还挂着的卷，空间统计里都算在里边。卷更是完全不在这份清单里。
 */
export function CleanupDialog() {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<Record<Choice, boolean>>({
    images: true,
    containers: true,
    networks: false,
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const nothingPicked = !OPTIONS.some((o) => picked[o.key]);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await pruneJunk(picked);
      const removed = r.images + r.containers + r.networks;
      setResult(
        removed === 0
          ? t('cleanup.nothing')
          : t('cleanup.done', { size: human(r.bytes), count: removed }),
      );
    } catch (e) {
      setResult(`${t('cleanup.fail')}: ${e instanceof Error ? e.message : ''}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onOpenChange={(open) => !open && setResult(null)}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-border/70 px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
        >
          <Trash2 className="size-3.5" />
          {t('home.cleanup')}
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('cleanup.title')}</DialogTitle>
          <DialogDescription>{t('cleanup.desc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          {OPTIONS.map((o) => (
            <label
              key={o.key}
              className="flex cursor-pointer items-center gap-3 rounded-xl border border-border/60 px-3.5 py-2.5 transition-colors hover:border-border"
            >
              <input
                type="checkbox"
                checked={picked[o.key]}
                onChange={(e) => setPicked({ ...picked, [o.key]: e.target.checked })}
                className="size-4 accent-foreground"
              />
              <span className="text-sm">{t(`cleanup.${o.labelKey}`)}</span>
            </label>
          ))}
          {result && (
            <p
              className={cn(
                'rounded-xl px-3.5 py-2.5 text-sm',
                result.startsWith(t('cleanup.fail')) ? 'bg-destructive/10 text-destructive' : 'bg-muted',
              )}
            >
              {result}
            </p>
          )}
        </div>

        <DialogFooter>
          <p className="mr-auto text-xs text-muted-foreground">{t('cleanup.volume_note')}</p>
          <Button onClick={run} disabled={busy || nothingPicked}>
            <Trash2 />
            {busy ? t('cleanup.running') : t('cleanup.run')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
