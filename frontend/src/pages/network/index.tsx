import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { get, post } from '../../lib/api';
import { toast } from '../../components/ui/sonner';
import { fetchDaemon, saveDaemon, type DaemonFile } from '../docker/_api';

type DnsStatus = {
  nameservers: string[];
  source: string;
  path: string;
};

type WgIface = { name: string; public_key: string; listen_port: string; peers: number };
type WgStatus = { installed: boolean; interfaces: WgIface[]; message: string };

export default function NetworkPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('nav.network')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('network.desc')}</p>
      </div>
      <DnsSection />
      <RegistrySection />
      <VpnSection />
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded-2xl border border-border/60 px-4 py-4 sm:px-5">
      <div>
        <h2 className="text-base font-medium">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
      </div>
      {children}
    </section>
  );
}

function DnsSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<DnsStatus | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    void get<DnsStatus>('/system/dns').then((r) => {
      if (r.success && r.data) {
        setStatus(r.data);
        setText(r.data.nameservers.join('\n'));
      }
    });
  };
  useEffect(load, []);

  const save = async () => {
    const nameservers = text.split('\n').map((s) => s.trim()).filter(Boolean);
    setBusy(true);
    try {
      const r = await post<DnsStatus>('/system/dns', { nameservers });
      if (!r.success || !r.data) throw new Error(r.message);
      setStatus(r.data);
      setText(r.data.nameservers.join('\n'));
      toast.success(t('network.dns_saved'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settings.save_failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t('network.dns_title')} desc={t('network.dns_desc')}>
      <p className="text-xs text-muted-foreground">
        {status
          ? t(status.source === 'resolvectl' ? 'network.dns_resolved' : 'network.dns_file', { path: status.path })
          : '—'}
      </p>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'1.1.1.1\n8.8.8.8'}
        className="h-24 max-w-md font-mono text-sm"
      />
      <Button onClick={() => void save()} disabled={busy}>
        {busy && <Loader2 className="animate-spin" />}
        {t('settings.save')}
      </Button>
    </Section>
  );
}

function RegistrySection() {
  const { t } = useTranslation();
  const [file, setFile] = useState<DaemonFile | null>(null);
  const [mirrors, setMirrors] = useState('');
  const [insecure, setInsecure] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetchDaemon()
      .then((d) => {
        setFile(d);
        setMirrors(d.mirrors.join('\n'));
        setInsecure(d.insecure_registries.join('\n'));
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
  }, []);

  const payload = useMemo(() => {
    const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
    let obj: Record<string, unknown> = {};
    try {
      const parsed = file?.content ? JSON.parse(file.content) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed;
    } catch {
      obj = {};
    }
    const m = lines(mirrors);
    const i = lines(insecure);
    if (m.length) obj['registry-mirrors'] = m;
    else delete obj['registry-mirrors'];
    if (i.length) obj['insecure-registries'] = i;
    else delete obj['insecure-registries'];
    return JSON.stringify(obj, null, 2);
  }, [file, insecure, mirrors]);

  const save = async () => {
    setBusy(true);
    try {
      const res = await saveDaemon(payload);
      toast.success(res.restarted ? t('docker.daemon_saved') : t('docker.daemon_saved_no_restart'));
      const next = await fetchDaemon();
      setFile(next);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t('network.registry_title')} desc={t('network.registry_desc')}>
      <div className="space-y-2">
        <Label>{t('docker.daemon_mirrors')}</Label>
        <Textarea
          value={mirrors}
          onChange={(e) => setMirrors(e.target.value)}
          placeholder="https://docker.1panel.live"
          className="h-24 max-w-lg font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">{t('docker.daemon_mirrors_hint')}</p>
      </div>
      <div className="space-y-2">
        <Label>{t('docker.daemon_insecure')}</Label>
        <Textarea
          value={insecure}
          onChange={(e) => setInsecure(e.target.value)}
          placeholder="registry.internal:5000"
          className="h-16 max-w-lg font-mono text-xs"
        />
      </div>
      <p className="text-xs text-muted-foreground">{t('docker.daemon_restart_warning')}</p>
      <Button onClick={() => void save()} disabled={busy || !file?.can_write}>
        {busy && <Loader2 className="animate-spin" />}
        {t('docker.daemon_save')}
      </Button>
    </Section>
  );
}

function VpnSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WgStatus | null>(null);
  const [name, setName] = useState('wg0');
  const [config, setConfig] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ name: string; up: boolean } | null>(null);

  const load = () => {
    void get<WgStatus>('/system/vpn').then((r) => {
      if (r.success && r.data) setStatus(r.data);
    });
  };
  useEffect(load, []);

  const importConf = async () => {
    setBusy(true);
    try {
      const r = await post('/system/vpn/import', { name, config });
      if (!r.success) throw new Error(r.message);
      toast.success(t('network.vpn_imported'));
      setConfig('');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settings.save_failed'));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      const r = await post(confirm.up ? '/system/vpn/up' : '/system/vpn/down', { name: confirm.name });
      if (!r.success) throw new Error(r.message);
      toast.success(confirm.up ? t('network.vpn_up_ok') : t('network.vpn_down_ok'));
      setConfirm(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settings.save_failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t('network.vpn_title')} desc={t('network.vpn_desc')}>
      {status && !status.installed && <p className="text-sm text-muted-foreground">{status.message}</p>}
      {status?.installed && status.interfaces.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('network.vpn_none')}</p>
      )}
      <div className="space-y-2">
        {status?.interfaces.map((iface) => (
          <div key={iface.name} className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-mono">{iface.name}</span>
            <span className="text-xs text-muted-foreground">
              {t('network.vpn_meta', { port: iface.listen_port || '—', peers: iface.peers })}
            </span>
            <Button size="sm" variant="outline" onClick={() => setConfirm({ name: iface.name, up: false })}>
              {t('network.vpn_down')}
            </Button>
          </div>
        ))}
      </div>
      <div className="grid max-w-lg gap-3">
        <div className="space-y-1.5">
          <Label>{t('network.vpn_name')}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} className="font-mono" />
        </div>
        <Textarea
          value={config}
          onChange={(e) => setConfig(e.target.value)}
          placeholder={'[Interface]\nPrivateKey = ...\nAddress = 10.0.0.2/32'}
          className="h-36 font-mono text-xs"
        />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void importConf()} disabled={busy || !config.trim() || !status?.installed}>
            {t('network.vpn_import')}
          </Button>
          <Button
            variant="outline"
            disabled={busy || !name.trim() || !status?.installed}
            onClick={() => setConfirm({ name: name.trim(), up: true })}
          >
            {t('network.vpn_up')}
          </Button>
        </div>
      </div>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{confirm?.up ? t('network.vpn_up') : t('network.vpn_down')}</DialogTitle>
            <DialogDescription>
              {confirm?.up
                ? t('network.vpn_up_confirm', { name: confirm.name })
                : t('network.vpn_down_confirm', { name: confirm?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              {t('sites.cancel')}
            </Button>
            <Button disabled={busy} onClick={() => void toggle()}>
              {busy && <Loader2 className="animate-spin" />}
              {t('settings.continue')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}
