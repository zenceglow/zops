import { useCallback, useEffect, useMemo, useState } from 'react';
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

const TABS: { id: Tab; label: string; icon: typeof ShieldCheck }[] = [
  { id: 'firewall', label: '防火墙', icon: ShieldCheck },
  { id: 'ssh', label: '端口访问记录', icon: Terminal },
  { id: 'alerts', label: '攻击 / 机器访问预警', icon: AlertTriangle },
];

export default function SecurityPage() {
  const [tab, setTab] = useState<Tab>('firewall');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">安全中心</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          这台机器被谁敲过门、敲的是什么、以及它现在对外露着哪些端口。
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {TABS.map(({ id, label, icon: Icon }) => (
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
            {label}
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
              {fw.tool ? `${fw.tool}` : '没有检测到防火墙'}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {fw.active ? '运行中' : '未启用'}
              </span>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{fw.summary}</p>
          </div>
          <p className="ml-auto text-xs text-muted-foreground">
            对外监听 <span className="font-mono text-foreground">{exposed.length}</span> 个端口
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 pt-5">
          <p className="text-sm font-medium">对外暴露的端口</p>
          {exposed.length === 0 ? (
            <p className="text-xs text-muted-foreground">没有绑在 0.0.0.0 上的监听端口。</p>
          ) : (
            <ul className="divide-y divide-border/60 text-xs">
              {exposed.map((p) => (
                <li key={`${p.address}-${p.port}`} className="flex items-center gap-3 py-1.5">
                  <span className="w-16 font-mono">{p.port}</span>
                  <span className="w-20 text-muted-foreground">{p.address}</span>
                  <span className="flex-1 truncate">
                    {p.container ? (
                      <>
                        容器 <span className="font-mono">{p.container}</span>
                      </>
                    ) : (
                      <span className="font-mono">{p.process}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="pt-1 text-[11px] text-muted-foreground">
            只绑在 127.0.0.1 上的服务不算对外暴露，这里没列出来。
          </p>
        </CardContent>
      </Card>

      {fw.rules.length > 0 && (
        <Card>
          <CardContent className="space-y-2 pt-5">
            <p className="text-sm font-medium">规则（末尾 {fw.rules.length} 行）</p>
            <pre className="max-h-72 overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-[11px] leading-relaxed">
              {fw.rules.join('\n')}
            </pre>
            <p className="text-[11px] text-muted-foreground">
              这里只是把规则读出来看。改规则还没做 —— 那要按发行版选后端，还得防着把
              自己锁在门外。
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ── 端口访问记录（22 / sshd） ── */

const RESULT_LABEL: Record<string, { text: string; className: string }> = {
  accepted: { text: '成功', className: 'text-emerald-600' },
  failed: { text: '失败', className: 'text-destructive' },
  invalid: { text: '无效用户', className: 'text-amber-600' },
};

function SshTab() {
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
      if (!res.success) throw new Error(res.message || '采集失败');
      await load();
      toast.success(
        res.data?.inserted ? `读到 ${res.data.inserted} 条新记录` : '没有新的记录',
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
        <Stat label="成功登录" value={summary?.accepted ?? 0} tone="ok" />
        <Stat label="失败尝试" value={summary?.failed ?? 0} tone="bad" />
        <Stat label="无效用户" value={summary?.invalid ?? 0} tone="warn" />
        <Stat label="来源 IP" value={summary?.ips ?? 0} />
      </div>

      {(summary?.top_failed.length ?? 0) > 0 && (
        <Card>
          <CardContent className="space-y-2 pt-5">
            <p className="text-sm font-medium">敲门最多的 IP（近 7 天）</p>
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
            <p className="text-sm font-medium">登录记录</p>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {['', 'accepted', 'failed', 'invalid'].map((r) => (
                <Button
                  key={r || 'all'}
                  size="sm"
                  variant={filter === r ? 'default' : 'outline'}
                  onClick={() => setFilter(r)}
                >
                  {r === '' ? '全部' : RESULT_LABEL[r].text}
                </Button>
              ))}
              <Button size="sm" variant="outline" onClick={scan} disabled={scanning}>
                {scanning ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                立刻采集
              </Button>
            </div>
          </div>

          {records.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              没有记录。日志文件（/var/log/secure 或 /var/log/auth.log）里暂时没有
              sshd 的认证行，或者这个面板读不到它。
            </p>
          ) : (
            <ul className="divide-y divide-border/60 text-xs">
              {records.map((r) => {
                const label = RESULT_LABEL[r.result] ?? { text: r.result, className: '' };
                return (
                  <li key={r.id} className="flex items-center gap-3 py-2">
                    <span className="w-32 shrink-0 text-muted-foreground">{r.time}</span>
                    <span className={cn('w-16 shrink-0', label.className)}>{label.text}</span>
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

const KIND_LABEL: Record<string, { text: string; className: string; icon: typeof Bug }> = {
  blocked: { text: '被拦下', className: 'bg-destructive/10 text-destructive', icon: ShieldOff },
  bot: { text: '扫描器', className: 'bg-amber-500/10 text-amber-600', icon: Bug },
  probe: { text: '探测敏感路径', className: 'bg-sky-500/10 text-sky-600', icon: AlertTriangle },
};

function AlertsTab() {
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
        从接入日志里挑出来的可疑访问，按「IP + 类型 + 路径 + 小时」聚合。近 24 小时：
        <span className="mx-1 font-mono text-foreground">{total}</span>条，涉及
        <span className="mx-1 font-mono text-foreground">{summary?.ips ?? 0}</span>个 IP。
      </p>

      <div className="flex flex-wrap gap-2">
        {[
          { id: '', label: `全部 ${total}` },
          { id: 'blocked', label: `被拦下 ${summary?.blocked ?? 0}` },
          { id: 'bot', label: `扫描器 ${summary?.bot ?? 0}` },
          { id: 'probe', label: `探测路径 ${summary?.probe ?? 0}` },
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
            没有预警。要么访问量本来就干净，要么采集还没跑过第一轮（访问日志采集每 15 秒一次）。
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {events.map((e) => {
            const meta = KIND_LABEL[e.kind] ?? {
              text: e.kind,
              className: 'bg-muted',
              icon: AlertTriangle,
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
                    <Row k="原因" v={e.reason} />
                    <Row k="主机" v={e.host || '—'} />
                    <Row k="请求" v={`${e.method} ${e.uri} → ${e.status}`} />
                    <Row k="User-Agent" v={e.ua || '—'} />
                    <Row k="次数" v={`${e.hits} 次`} />
                    <Row k="首次" v={e.first_seen} />
                    <Row k="最近" v={e.last_seen} />
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
