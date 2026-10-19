import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HardDrive, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { get, post } from '../../../lib/api';
import { toast } from '../../../components/ui/sonner';
import { formatBytes } from '../../monitor/_hooks/use-monitor';

type FileStats = {
  path: string;
  db_bytes: number;
  wal_bytes: number;
  shm_bytes: number;
  page_size: number;
  page_count: number;
  freelist_count: number;
  reclaimable_bytes: number;
};

type TableNote = {
  name: string;
  rows: number;
  /** retention | capped | fixed */
  bounded: string;
};

type StorageStats = {
  file: FileStats;
  retention_days: number;
  default_retention_days: number;
  audit_keep: number;
  tables: TableNote[];
  total_bytes: number;
};

type PruneReport = {
  days: number;
  deleted: [string, number][];
  total_deleted: number;
  freed_bytes_estimate: number;
};

type VacuumReport = { before_bytes: number; after_bytes: number; freed_bytes: number; duration_ms: number };

/**
 * 存储：看清 `ops.db` 到底占了多少、谁在长，以及能不能缩回去。
 *
 * 单独一屏是因为这里有个容易被误解的事实：SQLite 删了行，文件**不会**变小。
 * 行数和文件大小必须并排摆出来，否则用户只会看到"我明明清理了，怎么还是 300 MB"。
 */
export function StorageSettings() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState<'' | 'vacuum' | 'prune' | 'save' | 'reload'>('');

  const load = useCallback(async () => {
    setBusy('reload');
    try {
      const r = await get<StorageStats>('/system/database');
      if (r.success && r.data) {
        setStats(r.data);
        setDays(String(r.data.retention_days));
      } else {
        toast.error(r.message || t('settings.save_failed'));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settings.save_failed'));
    } finally {
      setBusy('');
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveRetention = async () => {
    const n = Number(days);
    if (!Number.isFinite(n) || n < 0 || n > 3650) {
      toast.error(t('settings.save_failed'));
      return;
    }
    setBusy('save');
    try {
      const r = await post('/system/database/retention', { days: Math.trunc(n) });
      if (!r.success) throw new Error(r.message);
      toast.success(t('settings.db_retention_saved'));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settings.save_failed'));
    } finally {
      setBusy('');
    }
  };

  const prune = async () => {
    setBusy('prune');
    try {
      const r = await post<PruneReport>('/system/database/prune');
      if (!r.success || !r.data) throw new Error(r.message);
      if (r.data.total_deleted === 0) {
        toast.success(t('settings.db_prune_none'));
      } else {
        toast.success(
          t('settings.db_prune_done', {
            n: r.data.total_deleted.toLocaleString(),
            size: formatBytes(r.data.freed_bytes_estimate),
          }),
        );
      }
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settings.save_failed'));
    } finally {
      setBusy('');
    }
  };

  const vacuum = async () => {
    setBusy('vacuum');
    try {
      const r = await post<VacuumReport>('/system/database/vacuum');
      if (!r.success || !r.data) throw new Error(r.message);
      toast.success(t('settings.db_vacuum_done', { size: formatBytes(r.data.freed_bytes) }));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settings.save_failed'));
    } finally {
      setBusy('');
    }
  };

  const file = stats?.file;
  const reclaim = file?.reclaimable_bytes ?? 0;

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('settings.section_database')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('settings.db_desc')}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void load()}
          disabled={busy !== ''}
          aria-label={t('common.refresh')}
        >
          {busy === 'reload' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label={t('settings.db_total')} value={formatBytes(stats?.total_bytes ?? 0)} strong />
        <Metric label={t('settings.db_body')} value={formatBytes(file?.db_bytes ?? 0)} />
        <Metric label={t('settings.db_wal')} value={formatBytes(file?.wal_bytes ?? 0)} />
      </div>

      <div className="rounded-2xl border border-border/60 px-4 py-3.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium">{t('settings.db_reclaimable')}</span>
          <span className="font-mono text-sm">{formatBytes(reclaim)}</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-foreground/60"
            style={{
              width: `${Math.min(100, file && file.db_bytes > 0 ? (reclaim / file.db_bytes) * 100 : 0)}%`,
            }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t('settings.db_reclaimable_hint')}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy !== ''} onClick={() => void prune()}>
            {busy === 'prune' ? <Loader2 className="animate-spin" /> : <Trash2 />}
            {t('settings.db_prune')}
          </Button>
          <Button size="sm" disabled={busy !== ''} onClick={() => void vacuum()}>
            {busy === 'vacuum' ? <Loader2 className="animate-spin" /> : <HardDrive />}
            {t('settings.db_vacuum')}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t('settings.db_vacuum_hint')}</p>
      </div>

      <section className="space-y-3">
        <Label>{t('settings.db_retention')}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={days}
            onChange={(e) => setDays(e.target.value)}
            inputMode="numeric"
            className="w-24 font-mono"
          />
          <span className="text-sm text-muted-foreground">{t('settings.db_retention_unit')}</span>
          <Button variant="outline" disabled={busy !== '' || days === ''} onClick={() => void saveRetention()}>
            {busy === 'save' ? <Loader2 className="animate-spin" /> : null}
            {t('settings.save')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('settings.db_retention_hint', { n: (stats?.audit_keep ?? 5000).toLocaleString() })}
        </p>
        {file && (
          <p className="font-mono text-xs text-muted-foreground">
            {t('settings.db_path')}: {file.path}
          </p>
        )}
      </section>

      <section className="space-y-2">
        <Label>{t('settings.db_tables')}</Label>
        <div className="overflow-hidden rounded-2xl border border-border/60">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">table</th>
                <th className="px-4 py-2 text-right font-medium">{t('settings.db_table_rows')}</th>
                <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">state</th>
              </tr>
            </thead>
            <tbody>
              {(stats?.tables ?? []).map((tb) => (
                <tr key={tb.name} className="border-t border-border/50">
                  <td className="px-4 py-1.5 font-mono text-[13px]">{tb.name}</td>
                  <td className="px-4 py-1.5 text-right font-mono tabular-nums">
                    {tb.rows.toLocaleString()}
                  </td>
                  <td className="hidden px-4 py-1.5 text-right text-xs text-muted-foreground sm:table-cell">
                    {tb.bounded === 'retention'
                      ? t('settings.db_bounded_retention')
                      : tb.bounded === 'capped'
                        ? t('settings.db_bounded_capped')
                        : t('settings.db_bounded_fixed')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-xl border border-border/60 px-3.5 py-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={strong ? 'mt-0.5 font-mono text-lg font-semibold' : 'mt-0.5 font-mono text-sm'}>
        {value}
      </div>
    </div>
  );
}
