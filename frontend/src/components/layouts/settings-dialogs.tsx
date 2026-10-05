import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Copy, Globe, Link2, Mail } from 'lucide-react';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { toast } from '../ui/sonner';
import { get, post, put } from '../../lib/api';
import type { SettingsDialog } from './settings-menu';

/**
 * 面板自己的联系方式。放在这里是让它只有一处：要改就改这两个常量。
 * 域名取自现网（carapi.zenceglow.com 那套配置里的根域），邮箱取自 Caddy 的
 * ACME 联系邮箱。
 */
export const PANEL_CONTACT = {
  email: 'dev@zenceglow.com',
  site: 'https://zenceglow.com',
};

const UNINSTALL_STEPS = `systemctl stop zenceglow-ops
systemctl disable zenceglow-ops
rm -f /etc/systemd/system/zenceglow-ops.service
rm -f /usr/local/bin/zenceglow-ops
systemctl daemon-reload

# 面板数据：数据库、回收站、配置都在这里，删掉就真的没了
rm -rf /var/lib/zenceglow-ops`;

function CopyBlock({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-xl border border-border/60 bg-muted/30 p-3 pr-20 font-mono text-xs leading-relaxed">
        {value}
      </pre>
      <Button
        variant="secondary"
        size="sm"
        className="absolute right-2 bottom-2"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        }}
      >
        {done ? <Check /> : <Copy />}
        {done ? '已复制' : '复制'}
      </Button>
    </div>
  );
}

type TimezoneInfo = { current: string; supported: boolean; common: string[]; message: string };

export function SettingsDialogs({
  open,
  onOpenChange,
}: {
  open: SettingsDialog | null;
  onOpenChange: (v: SettingsDialog | null) => void;
}) {
  const { t } = useTranslation();
  const [tz, setTz] = useState<TimezoneInfo | null>(null);
  const [zone, setZone] = useState('');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open === 'timezone') {
      get<TimezoneInfo>('/system/timezone')
        .then((r) => {
          if (r.success && r.data) {
            setTz(r.data);
            setZone(r.data.current);
          }
        })
        .catch(() => {});
    }
  }, [open]);

  const saveTimezone = async () => {
    setBusy(true);
    try {
      const r = await post('/system/timezone', { zone });
      if (!r.success) throw new Error(r.message);
      toast.success(t('settings.timezone_saved', { zone }));
      onOpenChange(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '设置失败');
    } finally {
      setBusy(false);
    }
  };

  /**
   * 给面板自己加一条反向代理 + 域名。
   *
   * 走 `/gateway/sites` 而不是自己拼文本：同一个域名已经绑过、或者配置里有别的
   * 错，都会在**写入之前**被拦下来。以前这里是直接把新块拼到原文后面 PUT 整个
   * 文件，拼错了没人拦 —— 那份坏配置会在下次 Caddy 重启时让**所有**站点一起
   * 下线（一份 Caddyfile 是一个整体，Caddy 不给"只坏一个站点"的余地）。
   */
  const bindDomain = async () => {
    const d = domain.trim();
    if (!d) return;
    setBusy(true);
    try {
      const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
      const block = `${d} {\n\treverse_proxy localhost:${port}\n}`;
      const added = await post('/gateway/sites', { addr: d, block });
      if (!added.success) throw new Error(added.message || '写入失败');
      await post('/gateway/reload');
      toast.success(t('settings.domain_bound', { domain: d }));
      setDomain('');
      onOpenChange(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '绑定失败');
    } finally {
      setBusy(false);
    }
  };

  const port = typeof window !== 'undefined' ? window.location.port || (window.location.protocol === 'https:' ? '443' : '80') : '';

  return (
    <>
      {/* 时区 */}
      <Dialog open={open === 'timezone'} onOpenChange={(v) => !v && onOpenChange(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.timezone_title')}</DialogTitle>
            <DialogDescription>
              {tz?.supported
                ? t('settings.timezone_desc', { current: tz.current })
                : tz?.message || t('settings.timezone_desc', { current: '—' })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Label>{t('settings.timezone_label')}</Label>
            <Input
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              placeholder="Asia/Shanghai"
              className="font-mono text-sm"
              list="tz-common"
            />
            <datalist id="tz-common">
              {tz?.common.map((z) => <option key={z} value={z} />)}
            </datalist>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {tz?.common.slice(1, 7).map((z) => (
                <button
                  key={z}
                  type="button"
                  onClick={() => setZone(z)}
                  className="rounded-lg border border-border/60 px-2 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                >
                  {z}
                </button>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => onOpenChange(null)}>
              {t('sites.cancel')}
            </Button>
            <Button onClick={saveTimezone} disabled={busy || !zone.trim() || !tz?.supported}>
              {t('settings.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 绑定面板域名 */}
      <Dialog open={open === 'bind-domain'} onOpenChange={(v) => !v && onOpenChange(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.bind_title')}</DialogTitle>
            <DialogDescription>{t('settings.bind_desc', { port })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Label>{t('settings.bind_label')}</Label>
            <Input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="ops.example.com"
              className="font-mono text-sm"
            />
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Link2 className="mt-0.5 size-3.5 shrink-0" />
              {t('settings.bind_hint')}
            </p>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => onOpenChange(null)}>
              {t('sites.cancel')}
            </Button>
            <Button onClick={bindDomain} disabled={busy || !domain.trim()}>
              {t('settings.bind_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 卸载 */}
      <Dialog open={open === 'uninstall'} onOpenChange={(v) => !v && onOpenChange(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('settings.uninstall_title')}</DialogTitle>
            <DialogDescription>{t('settings.uninstall_desc')}</DialogDescription>
          </DialogHeader>
          <div className="flex gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="text-muted-foreground">{t('settings.uninstall_warn')}</p>
          </div>
          <CopyBlock value={UNINSTALL_STEPS} />
        </DialogContent>
      </Dialog>

      {/* 联系我们 */}
      <Dialog open={open === 'contact'} onOpenChange={(v) => !v && onOpenChange(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.contact_title')}</DialogTitle>
            <DialogDescription>{t('settings.contact_desc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <a
              href={`mailto:${PANEL_CONTACT.email}`}
              className="flex items-center gap-2.5 rounded-xl border border-border/60 px-4 py-3 text-sm transition-colors hover:border-border"
            >
              <Mail className="size-4 text-muted-foreground" />
              <span className="font-mono">{PANEL_CONTACT.email}</span>
            </a>
            <a
              href={PANEL_CONTACT.site}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2.5 rounded-xl border border-border/60 px-4 py-3 text-sm transition-colors hover:border-border"
            >
              <Globe className="size-4 text-muted-foreground" />
              <span className="font-mono">{PANEL_CONTACT.site}</span>
            </a>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
