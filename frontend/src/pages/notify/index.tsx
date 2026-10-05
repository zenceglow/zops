import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BellRing, Plus, Send, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Skeleton } from '../../components/ui/skeleton';
import { toast } from '../../components/ui/sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { cn } from '../../lib/utils';
import {
  KINDS,
  fetchChannels,
  fetchEvents,
  fetchLog,
  removeChannel,
  saveChannel,
  testChannel,
  toggleChannel,
  type Channel,
  type EventDef,
  type NotifyLog,
} from './_api';

/**
 * 通知渠道。
 *
 * 面板上发生的事要能主动推到群里 —— 部署完了、容器掉了、压力顶到 90% —— 而不是
 * 等人自己想起来打开面板看。
 *
 * 页面结构就三块：渠道列表、配置弹窗、投递记录。投递记录是必须的：机器人静默
 * 失败过一次（签名不对、被移出群），没有记录就只能靠猜。
 */
export default function NotifyPage() {
  const { t } = useTranslation();
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [events, setEvents] = useState<EventDef[]>([]);
  const [log, setLog] = useState<NotifyLog[]>([]);
  const [editing, setEditing] = useState<Channel | 'new' | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<Channel | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [c, l] = await Promise.all([fetchChannels(), fetchLog()]);
      setChannels(c);
      setLog(l);
    } catch {
      setChannels([]);
    }
  }, []);

  useEffect(() => {
    void reload();
    void fetchEvents()
      .then(setEvents)
      .catch(() => setEvents([]));
  }, [reload]);

  const sendTest = async (c: Channel) => {
    setBusy(true);
    try {
      await testChannel(c.id);
      toast.success(t('notify.test_ok', { name: c.name }));
    } catch (e) {
      // 把对方回的原话带出来 —— 配通知最费时间的就是这一步。
      toast.error(e instanceof Error ? e.message : t('notify.test_fail'));
    } finally {
      setBusy(false);
      void reload();
    }
  };

  const toggle = async (c: Channel) => {
    try {
      await toggleChannel(c.id, !c.enabled);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('notify.save_fail'));
    }
  };

  const remove = async (c: Channel) => {
    try {
      await removeChannel(c.id);
      toast.success(t('notify.removed', { name: c.name }));
      setConfirmRemove(null);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('notify.save_fail'));
    }
  };

  if (!channels) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">{t('notify.title')}</h1>
        <Skeleton className="h-20 w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('notify.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('notify.subtitle')}</p>
        </div>
        <Button size="sm" className="ml-auto" onClick={() => setEditing('new')}>
          <Plus />
          {t('notify.add')}
        </Button>
      </div>

      {channels.length === 0 ? (
        <div className="rounded-2xl border border-border/60 py-12 text-center">
          <BellRing className="mx-auto size-7 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">{t('notify.empty')}</p>
          <p className="mt-1 text-xs text-muted-foreground/70">{t('notify.empty_hint')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {channels.map((c) => (
            <div
              key={c.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border/60 px-4 py-3"
            >
              <span
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  c.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                )}
                title={c.enabled ? t('notify.enabled') : t('notify.disabled')}
              />
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <span className="truncate">{c.name}</span>
                  <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {KINDS.find((k) => k.key === c.kind)?.label ?? c.kind}
                  </span>
                </p>
                <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={c.url_masked}>
                  {c.url_masked}
                </p>
              </div>

              <div className="flex min-w-0 flex-wrap gap-1">
                {c.events.map((e) => (
                  <span
                    key={e}
                    className="rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                  >
                    {events.find((d) => d.key === e)?.label ?? e}
                  </span>
                ))}
              </div>

              <span className="ml-auto text-[11px] text-muted-foreground">
                {c.last_at ? (
                  <span className={c.last_ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                    {c.last_at}
                    {c.last_ok ? ` · ${t('notify.ok')}` : ` · ${t('notify.failed')}`}
                  </span>
                ) : (
                  t('notify.never')
                )}
              </span>

              <div className="flex items-center gap-1">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void sendTest(c)}>
                  <Send />
                  {t('notify.test')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void toggle(c)}>
                  {c.enabled ? t('notify.disable') : t('notify.enable')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>
                  {t('notify.edit')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmRemove(c)}
                >
                  <Trash2 />
                </Button>
              </div>

              {!c.last_ok && c.last_error && (
                <p className="w-full truncate text-[11px] text-destructive" title={c.last_error}>
                  {c.last_error}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 投递记录 */}
      <div className="overflow-hidden rounded-2xl border border-border/60">
        <p className="border-b border-border/60 px-4 py-2 text-sm font-medium">
          {t('notify.log_title')}
        </p>
        {log.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">{t('notify.log_empty')}</p>
        ) : (
          <div className="max-h-[38vh] overflow-y-auto">
            {log.map((row) => (
              <div
                key={row.id}
                className="grid grid-cols-[130px_1fr_100px_52px] items-center gap-3 border-b border-border/40 px-4 py-1.5 text-xs last:border-0"
              >
                <span className="font-mono text-muted-foreground">{row.at}</span>
                <span className="truncate" title={row.detail}>
                  {row.channel}
                  <span className="ml-2 text-muted-foreground">{row.event}</span>
                </span>
                <span
                  className={cn(
                    'truncate text-right',
                    row.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive',
                  )}
                >
                  {row.ok ? t('notify.ok') : row.detail || t('notify.failed')}
                </span>
                <span className="text-right font-mono text-muted-foreground">{row.status || '—'}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <ChannelDialog
          channel={editing === 'new' ? null : editing}
          events={events}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}

      {/* 删掉一个渠道 = 以后这类事再也不会通知到人。 */}
      <Dialog open={confirmRemove !== null} onOpenChange={(o) => !o && setConfirmRemove(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('notify.remove_title', { name: confirmRemove?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('notify.remove_desc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmRemove(null)}>
              {t('sites.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => confirmRemove && void remove(confirmRemove)}>
              {t('notify.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ChannelDialog({
  channel,
  events,
  onClose,
  onSaved,
}: {
  channel: Channel | null;
  events: EventDef[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(channel?.name ?? '');
  const [kind, setKind] = useState(channel?.kind ?? 'feishu');
  const [url, setUrl] = useState(channel?.url ?? '');
  const [secret, setSecret] = useState(channel?.secret ?? '');
  const [picked, setPicked] = useState<string[]>(channel?.events ?? ['deploy', 'pressure']);
  const [saving, setSaving] = useState(false);

  const def = KINDS.find((k) => k.key === kind);
  const needsSecret = kind === 'feishu' || kind === 'dingtalk';

  const submit = async () => {
    setSaving(true);
    try {
      await saveChannel({
        id: channel?.id,
        name,
        kind,
        url,
        secret,
        events: picked,
        enabled: channel?.enabled ?? true,
      });
      toast.success(t('notify.saved'));
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('notify.save_fail'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{channel ? t('notify.edit') : t('notify.add')}</DialogTitle>
          <DialogDescription>{t(`notify.hint_${kind}`)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-2">
            <Label>{t('notify.type')}</Label>
            <div className="flex flex-wrap gap-1.5">
              {KINDS.map((k) => (
                <button
                  key={k.key}
                  type="button"
                  onClick={() => setKind(k.key)}
                  className={cn(
                    'rounded-xl border px-2.5 py-1 text-xs transition-colors',
                    kind === k.key
                      ? 'border-foreground/30 bg-muted font-medium text-foreground'
                      : 'border-border/60 text-muted-foreground hover:text-foreground',
                  )}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t('notify.name')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('notify.name_placeholder')}
            />
          </div>

          <div className="space-y-2">
            <Label>{t('notify.url')}</Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              spellCheck={false}
              className="font-mono text-xs"
              placeholder={def?.placeholder}
            />
          </div>

          {needsSecret && (
            <div className="space-y-2">
              <Label>{t('notify.secret')}</Label>
              <Input
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                spellCheck={false}
                type="password"
                className="font-mono text-xs"
                placeholder={t('notify.secret_placeholder')}
              />
              <p className="text-xs text-muted-foreground">{t('notify.secret_hint')}</p>
            </div>
          )}

          <div className="space-y-2">
            <Label>{t('notify.events')}</Label>
            <div className="flex flex-wrap gap-1.5">
              {events.map((e) => {
                const on = picked.includes(e.key);
                return (
                  <button
                    key={e.key}
                    type="button"
                    onClick={() =>
                      setPicked((prev) =>
                        prev.includes(e.key) ? prev.filter((x) => x !== e.key) : [...prev, e.key],
                      )
                    }
                    className={cn(
                      'rounded-xl border px-2.5 py-1 text-xs transition-colors',
                      on
                        ? 'border-foreground/30 bg-muted font-medium text-foreground'
                        : 'border-border/60 text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {e.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t('sites.cancel')}
          </Button>
          <Button onClick={submit} disabled={saving || !name.trim() || !url.trim() || picked.length === 0}>
            {t('sites.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
