import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { Textarea } from '../../../components/ui/textarea';
import { toast } from '../../../components/ui/sonner';
import { fetchDaemon, saveDaemon, type DaemonFile } from '../_api';

/**
 * Docker 引擎配置。
 *
 * 之前这里只有一个"展开 JSON" —— 也就是说，想加个镜像加速器得自己去机器上改
 * `/etc/docker/daemon.json`。而**这是国内装完 Docker 第一个要改的东西**，属于
 * 高频操作，面板不该把它推回给 SSH。
 *
 * 表单只铺开最常改的两个字段，其余原样保留（改的时候是在原对象上改，不是重建），
 * 想改别的就切到"直接编辑 JSON"。
 */
export function DaemonDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const [file, setFile] = useState<DaemonFile | null>(null);
  const [mirrors, setMirrors] = useState('');
  const [insecure, setInsecure] = useState('');
  const [raw, setRaw] = useState('');
  const [rawMode, setRawMode] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setRawMode(false);
    fetchDaemon()
      .then((d) => {
        setFile(d);
        setMirrors(d.mirrors.join('\n'));
        setInsecure(d.insecure_registries.join('\n'));
        setRaw(d.content || '{\n}\n');
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
  }, [open]);

  /** 要写下去的 JSON 文本：表单模式和原始模式二选一。 */
  const payload = useMemo(() => {
    if (rawMode) return raw;
    const lines = (s: string) =>
      s
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean);

    // 在**原对象**上改，不重建 —— 别人写在里面的 log-driver、data-root 这些
    // 字段不该因为我们加一行镜像地址就被抹掉。
    let obj: Record<string, unknown> = {};
    try {
      const parsed = file?.content ? JSON.parse(file.content) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      // 原文件不是合法 JSON 时无从保留，给个干净的起点（后端还会再校验一次）
      obj = {};
    }
    const m = lines(mirrors);
    const i = lines(insecure);
    if (m.length) obj['registry-mirrors'] = m;
    else delete obj['registry-mirrors'];
    if (i.length) obj['insecure-registries'] = i;
    else delete obj['insecure-registries'];
    return JSON.stringify(obj, null, 2);
  }, [file, insecure, mirrors, raw, rawMode]);

  const save = async () => {
    setBusy(true);
    try {
      const res = await saveDaemon(payload);
      toast.success(
        res.restarted
          ? t('docker.daemon_saved')
          : t('docker.daemon_saved_no_restart'),
      );
      if (res.backup) toast(t('docker.daemon_backup', { path: res.backup }));
      onSaved?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-xl [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>{t('docker.daemon_title')}</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">
            {file?.path ?? '…'}
          </DialogDescription>
        </DialogHeader>

        {file && !file.can_write && (
          <p className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {t('docker.daemon_readonly')}
          </p>
        )}

        {rawMode ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{t('docker.daemon_raw_hint')}</p>
            <Textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              spellCheck={false}
              className="h-56 font-mono text-xs"
            />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">{t('docker.daemon_mirrors')}</p>
              <Textarea
                value={mirrors}
                onChange={(e) => setMirrors(e.target.value)}
                spellCheck={false}
                placeholder="https://docker.1panel.live"
                className="h-24 font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">{t('docker.daemon_mirrors_hint')}</p>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">{t('docker.daemon_insecure')}</p>
              <Textarea
                value={insecure}
                onChange={(e) => setInsecure(e.target.value)}
                spellCheck={false}
                placeholder="registry.internal:5000"
                className="h-16 font-mono text-xs"
              />
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => setRawMode((v) => !v)}
          className="self-start text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {rawMode ? t('docker.daemon_use_form') : t('docker.daemon_use_raw')}
        </button>

        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {t('docker.daemon_restart_warning')}
        </p>

        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('sites.cancel')}
          </Button>
          <Button disabled={busy || !file} onClick={() => void save()}>
            {busy && <Loader2 className="animate-spin" />}
            {t('docker.daemon_save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
