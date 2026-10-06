import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Bug,
  ChevronDown,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Terminal,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { Skeleton } from '../../components/ui/skeleton';
import { toast } from '../../components/ui/sonner';
import { cn } from '../../lib/utils';
import {
  fetchEventSummary,
  fetchEvents,
  fetchFirewall,
  fetchSshRecords,
  fetchSshSummary,
  scanNow,
  type Firewall,
  type SecurityEvent,
  type SecuritySummary,
  type SshRecord,
  type SshSummary,
} from './_api';

type Tab = 'firewall' | 'ssh' | 'alerts';

const TABS: { id: Tab; labelKey: string; icon: typeof ShieldCheck }[] = [
  { id: 'firewall', labelKey: 'security.tab_firewall', icon: ShieldCheck },
  { id: 'ssh', labelKey: 'security.tab_ssh', icon: Terminal },
  { id: 'alerts', labelKey: 'security.tab_alerts', icon: AlertTriangle },
];

export default function SecurityPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('firewall');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('security.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('security.subtitle')}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {TABS.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-xl border border-border/60 px-3 py-1.5 text-sm transition-colors',
              tab === id ? 'border-primary/50 bg-primary/10' : 'hover:bg-muted/50',
            )}
          >
            <Icon className="size-3.5" />
            {t(labelKey)}
          </button>
        ))}
      </div>

      {tab === 'firewall' && <FirewallTab />}
      {tab === 'ssh' && <SshTab />}
      {tab === 'alerts' && <AlertsTab />}
    </div>
  );
}

/* ── 防火墙：现状 + 暴露面 ── */

function FirewallTab() {
  const { t } = useTranslation();
  const [fw, setFw] = useState<Firewall | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchFirewall()
      .then(setFw)
      .catch((e) => toast.error(String(e.message ?? e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Skeleton className="h-48 w-full" />;
  if (!fw) return null;

  const exposed = fw.exposed.filter((p) => p.public);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 pt-5">
          <div
            className={cn(
              'flex size-10 items-center justify-center rounded-xl',
              fw.active ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground',
            )}
          >
            {fw.active ? <ShieldCheck className="size-5" /> : <ShieldOff className="size-5" />}
          </div>
          <div>
            <p className="text-sm font-medium">
              {fw.tool ? `${fw.tool}` : t('security.fw_none')}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {fw.active ? t('security.fw_running') : t('security.fw_stopped')}
              </span>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{fw.summary}</p>
          </div>
          <p className="ml-auto text-xs text-muted-foreground">
            {t('security.exposed_count', { n: exposed.length })}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 pt-5">
          <p className="text-sm font-medium">{t('security.exposed_title')}</p>
          {exposed.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('security.exposed_empty')}</p>
          ) : (
            <ul className="divide-y divide-border/60 text-xs">
              {exposed.map((p) => (
                <li key={`${p.address}-${p.port}`} className="flex items-center gap-3 py-1.5">
                  <span className="w-16 font-mono">{p.port}</span>
                  <span className="w-20 text-muted-foreground">{p.address}</span>
                  <span className="flex-1 truncate">
                    {p.container ? (
                      <span className="font-mono">{p.container}</span>
                    ) : (
                      <span className="font-mono">{p.process}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="pt-1 text-[11px] text-muted-foreground">{t('security.exposed_note')}</p>
        </CardContent>
      </Card>

      {fw.rules.length > 0 && (
        <Card>
          <CardContent className="space-y-2 pt-5">
            <p className="text-sm font-medium">
              {t('security.rules_title', { n: fw.rules.length })}
            </p>
            <pre className="max-h-72 overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-[11px] leading-relaxed">
              {fw.rules.join('\n')}
            </pre>
            <p className="text-[11px] text-muted-foreground">{t('security.rules_note')}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ── 端口访问记录（22 / sshd） ── */

const RESULT_LABEL: Record<string, { key: string; className: string }> = {
  accepted: { key: 'security.result_accepted', className: 'text-emerald-600' },
  failed: { key: 'security.result_failed', className: 'text-destructive' },
  invalid: { key: 'security.result_invalid', className: 'text-amber-600' },
};

function SshTab() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<SshSummary | null>(null);
  const [records, setRecords] = useState<SshRecord[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  const load = useCallback(async () => {
    const [s, r] = await Promise.all([fetchSshSummary(), fetchSshRecords(filter)]);
    setSummary(s);
    setRecords(r);
  }, [filter]);

  useEffect(() => {
    load()
      .catch((e) => toast.error(String(e.message ?? e)))
      .finally(() => setLoading(false));
  }, [load]);

  const scan = async () => {
    setScanning(true);
    try {
      const res = await scanNow();
      if (!res.success) throw new Error(res.message || t('security.scan_failed'));
      await load();
      toast.success(
        res.data?.inserted
          ? t('security.scan_new', { n: res.data.inserted })
          : t('security.scan_none'),
      );
    } catch (e) {
      toast.error(String((e as Error).message));
    } finally {
      setScanning(false);
    }
  };

  if (loading) return <Skeleton className="h-48 w-full" />;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label={t('security.ssh_accepted')} value={summary?.accepted ?? 0} tone="ok" />
        <Stat label={t('security.ssh_failed')} value={summary?.failed ?? 0} tone="bad" />
        <Stat label={t('security.ssh_invalid')} value={summary?.invalid ?? 0} tone="warn" />
        <Stat label={t('security.ssh_ips')} value={summary?.ips ?? 0} />
      </div>

      {(summary?.top_failed.length ?? 0) > 0 && (
        <Card>
          <CardContent className="space-y-2 pt-5">
            <p className="text-sm font-medium">{t('security.ssh_top')}</p>
            <div className="flex flex-wrap gap-2">
              {summary!.top_failed.map((t) => (
                <span
                  key={t.ip}
                  className="rounded-lg border border-border/60 px-2 py-1 font-mono text-[11px]"
                >
                  {t.ip}
                  <span className="ml-1.5 text-destructive">{t.count}</span>
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-3 pt-5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{t('security.ssh_records')}</p>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {['', 'accepted', 'failed', 'invalid'].map((r) => (
                <Button
                  key={r || 'all'}
                  size="sm"
                  variant={filter === r ? 'default' : 'outline'}
                  onClick={() => setFilter(r)}
                >
                  {r === '' ? t('security.filter_all') : t(RESULT_LABEL[r].key)}
                </Button>
              ))}
              <Button size="sm" variant="outline" onClick={scan} disabled={scanning}>
                {scanning ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {t('security.scan')}
              </Button>
            </div>
          </div>

          {records.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('security.ssh_empty')}</p>
          ) : (
            <ul className="divide-y divide-border/60 text-xs">
              {records.map((r) => {
                const entry = RESULT_LABEL[r.result];
                const label = entry ? t(entry.key) : r.result;
                const className = entry?.className ?? '';
                return (
                  <li key={r.id} className="flex items-center gap-3 py-2">
                    <span className="w-32 shrink-0 text-muted-foreground">{r.time}</span>
                    <span className={cn('w-16 shrink-0', className)}>{label}</span>
                    <span className="w-32 shrink-0 font-mono">{r.ip}</span>
                    <span className="w-24 shrink-0 truncate">
                      {r.user || '—'}
                      {r.method && (
                        <span className="ml-1 text-muted-foreground">({r.method})</span>
                      )}
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground">{r.raw}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ── 预警 ── */

const KIND_LABEL: Record<string, { key: string; className: string; icon: typeof Bug }> = {
  blocked: { key: 'security.kind_blocked', className: 'bg-destructive/10 text-destructive', icon: ShieldOff },
  bot: { key: 'security.kind_bot', className: 'bg-amber-500/10 text-amber-600', icon: Bug },
  probe: { key: 'security.kind_probe', className: 'bg-sky-500/10 text-sky-600', icon: AlertTriangle },
};

function AlertsTab() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<SecuritySummary | null>(null);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [kind, setKind] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([fetchEventSummary(24), fetchEvents(kind)])
      .then(([s, e]) => {
        setSummary(s);
        setEvents(e);
      })
      .catch((e) => toast.error(String(e.message ?? e)))
      .finally(() => setLoading(false));
  }, [kind]);

  const total = useMemo(
    () => (summary ? summary.blocked + summary.bot + summary.probe : 0),
    [summary],
  );

  if (loading) return <Skeleton className="h-48 w-full" />;

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        {t('security.alerts_intro', { total, ips: summary?.ips ?? 0 })}
      </p>

      <div className="flex flex-wrap gap-2">
        {[
          { id: '', label: `${t('security.filter_all')} ${total}` },
          { id: 'blocked', label: `${t('security.kind_blocked')} ${summary?.blocked ?? 0}` },
          { id: 'bot', label: `${t('security.kind_bot')} ${summary?.bot ?? 0}` },
          { id: 'probe', label: `${t('security.kind_probe')} ${summary?.probe ?? 0}` },
        ].map((f) => (
          <Button
            key={f.id || 'all'}
            size="sm"
            variant={kind === f.id ? 'default' : 'outline'}
            onClick={() => setKind(f.id)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {events.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t('security.alerts_empty')}
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {events.map((e) => {
            const entry = KIND_LABEL[e.kind];
            const meta = {
              text: entry ? t(entry.key) : e.kind,
              className: entry?.className ?? 'bg-muted',
              icon: entry?.icon ?? AlertTriangle,
            };
            const Icon = meta.icon;
            const expanded = open === e.id;
            return (
              <li key={e.id} className="rounded-2xl border border-border/60">
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : e.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  <span
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-0.5 text-[10px]',
                      meta.className,
                    )}
                  >
                    <Icon className="size-3" />
                    {meta.text}
                  </span>
                  <span className="w-32 shrink-0 font-mono text-xs">{e.ip}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                    {e.method} {e.uri}
                  </span>
                  {e.hits > 1 && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      ×{e.hits}
                    </span>
                  )}
                  <span className="hidden w-32 shrink-0 text-right text-[11px] text-muted-foreground sm:block">
                    {e.last_seen}
                  </span>
                  <ChevronDown
                    className={cn('size-3.5 shrink-0 transition-transform', expanded && 'rotate-180')}
                  />
                </button>
                {expanded && (
                  <div className="space-y-1.5 border-t border-border/60 px-4 py-3 text-[11px]">
                    <Row k={t('security.detail_reason')} v={e.reason} />
                    <Row k={t('security.detail_host')} v={e.host || '—'} />
                    <Row k={t('security.detail_request')} v={`${e.method} ${e.uri} → ${e.status}`} />
                    <Row k={t('security.detail_ua')} v={e.ua || '—'} />
                    <Row k={t('security.detail_hits')} v={t('security.hits', { n: e.hits })} />
                    <Row k={t('security.detail_first')} v={e.first_seen} />
                    <Row k={t('security.detail_last')} v={e.last_seen} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-3">
      <span className="w-20 shrink-0 text-muted-foreground">{k}</span>
      <span className="min-w-0 flex-1 break-all font-mono">{v}</span>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'ok' | 'warn' | 'bad';
}) {
  const color =
    tone === 'ok'
      ? 'text-emerald-600'
      : tone === 'warn'
        ? 'text-amber-600'
        : tone === 'bad'
          ? 'text-destructive'
          : '';
  return (
    <div className="rounded-2xl border border-border/60 px-4 py-3.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('mt-1 font-mono text-lg', color)}>{value}</p>
    </div>
  );
}
