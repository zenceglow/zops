import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import {
  Download,
  Fingerprint,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { MembersPanel } from '../../members/_components/members-panel';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { get, post } from '../../../lib/api';
import { cn } from '../../../lib/utils';
import { toast } from '../../../components/ui/sonner';
import { usePanelPrefs } from '../../../stores/panel-prefs';
import useUserStore from '../../../stores/user.store';
import type { UpdateStatus } from '../../../hooks/use-release';

type Section = 'basic' | 'members' | 'info';

type AccessState = { public: boolean; bind: string; manageable: boolean };

type PanelInfo = {
  version: string;
  uptime_seconds: number;
  host: {
    hostname: string;
    machine_id: string;
    docker_id: string;
    started_at: string;
    port: string;
  };
};

const SECTIONS: Section[] = ['basic', 'members', 'info'];

export default function PanelSettingsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const raw = params.get('section');
  const section: Section = SECTIONS.includes(raw as Section) ? (raw as Section) : 'basic';

  return (
    <div className="flex flex-col gap-8 sm:flex-row sm:gap-10">
      <nav className="flex shrink-0 gap-1 sm:w-40 sm:flex-col">
        {SECTIONS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setParams({ section: id })}
            className={cn(
              'rounded-xl px-3 py-2 text-left text-sm transition-colors',
              section === id
                ? 'bg-foreground/10 text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            {t(`settings.section_${id}`)}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        {section === 'basic' && <BasicSettings />}
        {section === 'members' && <MembersPanel embedded />}
        {section === 'info' && <PanelInfo />}
      </div>
    </div>
  );
}

function BasicSettings() {
  const { t } = useTranslation();
  const prefs = usePanelPrefs();
  const [title, setTitle] = useState('');
  const [domain, setDomain] = useState('');
  const [access, setAccess] = useState<AccessState | null>(null);
  const [busy, setBusy] = useState(false);
  const [closeStep, setCloseStep] = useState<0 | 1 | 2>(0);

  useEffect(() => {
    void prefs.load();
    void get<AccessState>('/system/access')
      .then((r) => {
        if (r.success && r.data) setAccess(r.data);
      })
      .catch(() => {});
  }, [prefs.load]);

  useEffect(() => {
    setTitle(prefs.title);
    setDomain(prefs.domain);
  }, [prefs.title, prefs.domain]);

  const saveTitle = async () => {
    setBusy(true);
    try {
      const r = await post<{ title: string; domain: string }>('/system/panel/prefs', { title });
      if (!r.success || !r.data) throw new Error(r.message);
      prefs.apply({ title: r.data.title });
      toast.success(t('settings.title_saved'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settings.save_failed'));
    } finally {
      setBusy(false);
    }
  };

  const bindDomain = async () => {
    const d = domain.trim();
    if (!d) return;
    setBusy(true);
    try {
      const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
      const block = `${d} {\n\treverse_proxy localhost:${port}\n}`;
      const added = await post('/gateway/sites', { addr: d, block });
      if (!added.success && !(added.message || '').includes('已经有一个入口')) {
        throw new Error(added.message || t('settings.save_failed'));
      }
      await post('/gateway/reload');
      const marked = await post<{ title: string; domain: string }>('/system/panel/prefs', { domain: d });
      if (!marked.success || !marked.data) throw new Error(marked.message);
      prefs.apply({ domain: marked.data.domain });
      toast.success(t('settings.domain_bound', { domain: d }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settings.save_failed'));
    } finally {
      setBusy(false);
    }
  };

  const setPublic = async (next: boolean) => {
    setBusy(true);
    try {
      const r = await post<{ restarting: boolean }>('/system/access', { public: next });
      if (!r.success) throw new Error(r.message);
      setAccess((s) => (s ? { ...s, public: next, bind: next ? '0.0.0.0' : '127.0.0.1' } : s));
      toast.success(next ? t('settings.access_opened') : t('settings.access_closed'));
      setCloseStep(0);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settings.save_failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('settings.section_basic')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('settings.basic_desc')}</p>
      </div>

      <section className="space-y-3">
        <Label>{t('settings.site_title')}</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="ZOPS"
            className="max-w-sm"
          />
          <Button onClick={() => void saveTitle()} disabled={busy}>
            {t('settings.save')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('settings.site_title_desc')}</p>
      </section>

      <section className="space-y-3">
        <Label>{t('settings.bind_domain')}</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="ops.example.com"
            className="max-w-sm font-mono text-sm"
          />
          <Button onClick={() => void bindDomain()} disabled={busy || !domain.trim()}>
            {t('settings.bind_confirm')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('settings.bind_hint')}</p>
        {prefs.domain && (
          <p className="text-xs text-muted-foreground">
            {t('settings.domain_current', { domain: prefs.domain })}
          </p>
        )}
      </section>

      <section className="space-y-3">
        <Label>{t('settings.access_title')}</Label>
        <p className="text-sm text-muted-foreground">
          {access
            ? access.public
              ? t('settings.access_on', { bind: access.bind })
              : t('settings.access_off', { bind: access.bind })
            : '—'}
        </p>
        {access && !access.manageable && (
          <p className="text-xs text-amber-600">{t('settings.access_unmanaged')}</p>
        )}
        <div className="flex gap-2">
          {access?.public ? (
            <Button
              variant="outline"
              disabled={busy || !access.manageable}
              onClick={() => setCloseStep(1)}
            >
              {t('settings.access_close')}
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={busy || !access?.manageable}
              onClick={() => void setPublic(true)}
            >
              {t('settings.access_open')}
            </Button>
          )}
        </div>
      </section>

      <Dialog open={closeStep > 0} onOpenChange={(o) => !o && setCloseStep(0)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.access_close')}</DialogTitle>
            <DialogDescription>
              {closeStep === 1 ? t('settings.access_confirm1') : t('settings.access_confirm2')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCloseStep(0)}>
              {t('sites.cancel')}
            </Button>
            {closeStep === 1 ? (
              <Button onClick={() => setCloseStep(2)}>{t('settings.continue')}</Button>
            ) : (
              <Button variant="destructive" disabled={busy} onClick={() => void setPublic(false)}>
                {t('settings.access_close')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function humanUptime(seconds: number, t: (k: string, o?: Record<string, unknown>) => string) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return t('about.uptime_dh', { d: days, h: hours });
  if (hours > 0) return t('about.uptime_hm', { h: hours, m: mins });
  return t('about.uptime_m', { m: mins });
}

function PanelInfo() {
  const { t } = useTranslation();
  const isSuper = useUserStore((s) => s.user?.role === 'super_admin');
  const [info, setInfo] = useState<PanelInfo | null>(null);
  const [release, setRelease] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [fetched, setFetched] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [uninstallStep, setUninstallStep] = useState<0 | 1 | 2>(0);
  const [left, setLeft] = useState(5);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void get<PanelInfo>('/system/panel').then((r) => {
      if (r.success && r.data) setInfo(r.data);
    });
    void get<UpdateStatus>('/system/release').then((r) => {
      if (r.success && r.data) setRelease(r.data);
    });
  }, []);

  useEffect(() => {
    if (uninstallStep !== 2) return;
    setLeft(5);
    const id = window.setInterval(() => setLeft((n) => (n > 0 ? n - 1 : 0)), 1000);
    return () => window.clearInterval(id);
  }, [uninstallStep]);

  const checkNow = async () => {
    setChecking(true);
    try {
      const res = await post<{ fetched: boolean; status: UpdateStatus }>('/system/release/check');
      if (res.success && res.data) {
        setRelease(res.data.status);
        setFetched(res.data.fetched);
        toast.success(
          res.data.fetched && res.data.status.has_update
            ? t('about.update_available', { v: res.data.status.latest })
            : res.data.fetched
              ? t('about.up_to_date')
              : t('about.check_failed'),
        );
      } else {
        setFetched(false);
        toast.error(res.message || t('about.check_failed'));
      }
    } catch {
      setFetched(false);
      toast.error(t('about.check_failed'));
    } finally {
      setChecking(false);
    }
  };

  const updateNow = async () => {
    setUpdating(true);
    const res = await post('/system/release/apply');
    if (!res.success) {
      toast.error(res.message || t('about.check_failed'));
      setUpdating(false);
      return;
    }
    toast.success(t('about.updating'));
  };

  const uninstall = async () => {
    setBusy(true);
    try {
      const r = await post('/system/uninstall');
      if (!r.success) throw new Error(r.message);
      toast.success(t('settings.uninstall_started'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settings.save_failed'));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('settings.section_info')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('settings.info_desc')}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Info k={t('about.version')} v={info?.version ?? '—'} />
        <Info k={t('about.uptime')} v={info ? humanUptime(info.uptime_seconds, t) : '—'} />
        <Info k={t('about.host')} v={info?.host.hostname ?? '—'} />
        <Info k={t('about.started_at')} v={info?.host.started_at ?? '—'} />
        <Info k={t('about.docker_id')} v={info?.host.docker_id || '—'} />
        <Info k={t('about.machine_id')} v={info?.host.machine_id || '—'} />
      </div>
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Fingerprint className="mt-0.5 size-3.5 shrink-0" />
        {t('about.fingerprint_hint')}
      </p>

      <section className="space-y-2 rounded-2xl border border-border/60 px-4 py-4">
        <p className="text-sm">
          {release?.has_update
            ? t('about.update_available', { v: release.latest })
            : fetched && release?.latest
              ? t('about.up_to_date')
              : '—'}
        </p>
        {!fetched && <p className="text-xs text-amber-600">{t('about.check_failed')}</p>}
        {release?.last_error && (
          <p className="text-xs text-destructive">{t('update.last_error', { msg: release.last_error })}</p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="outline" onClick={() => void checkNow()} disabled={checking || updating}>
            {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {checking ? t('about.checking') : t('about.check_update')}
          </Button>
          {release?.has_update && release.can_apply && (
            <Button size="sm" onClick={() => void updateNow()} disabled={updating}>
              {updating ? <Loader2 className="animate-spin" /> : <Download />}
              {t('about.update_now')}
            </Button>
          )}
        </div>
      </section>

      {isSuper && (
        <section>
          <Button variant="outline" className="text-destructive" onClick={() => setUninstallStep(1)}>
            {t('settings.uninstall')}
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">{t('settings.uninstall_only_panel')}</p>
        </section>
      )}

      <Dialog open={uninstallStep > 0} onOpenChange={(o) => !busy && !o && setUninstallStep(0)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.uninstall_title')}</DialogTitle>
            <DialogDescription>
              {uninstallStep === 1 ? t('settings.uninstall_only_panel') : t('settings.uninstall_confirm')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" disabled={busy} onClick={() => setUninstallStep(0)}>
              {t('sites.cancel')}
            </Button>
            {uninstallStep === 1 ? (
              <Button variant="destructive" onClick={() => setUninstallStep(2)}>
                {t('settings.continue')}
              </Button>
            ) : (
              <Button variant="destructive" disabled={left > 0 || busy} onClick={() => void uninstall()}>
                {left > 0 ? t('settings.uninstall_wait', { n: left }) : t('settings.uninstall_go')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Info({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-xl border border-border/60 px-3 py-2.5">
      <div className="text-[11px] text-muted-foreground">{k}</div>
      <div className="mt-0.5 truncate font-mono text-sm">{v}</div>
    </div>
  );
}
