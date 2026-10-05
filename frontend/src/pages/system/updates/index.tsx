import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, RefreshCw, ShieldCheck, Terminal } from 'lucide-react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Card, CardContent } from '../../../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { Skeleton } from '../../../components/ui/skeleton';
import { cn } from '../../../lib/utils';
import { applyUpdates, checkUpdates, fetchUpdates, type UpdateReport } from './_api';
import { PageHeader } from './_components/page-header';

/**
 * 漏洞修复。
 *
 * 面板可能装在 Ubuntu / Debian / CentOS / Rocky 上，所以检测分两步：先认发行版
 * （读 /etc/os-release），再按发行版挑包管理器（apt / dnf / yum）。认不出来就如实
 * 说"不支持"，不猜也不假装能修。
 *
 * "待修复"这个数会进首页的运行评分，由服务端每 6 小时自查一次 —— 所以这页的重点
 * 不是"手点一下检查"，而是**随时打开都能看到主机当前的风险状态**。
 */
export default function UpdatesPage() {
  const { t } = useTranslation();
  const [report, setReport] = useState<UpdateReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [output, setOutput] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchUpdates()
      .then(setReport)
      .catch(() => setReport(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const recheck = async () => {
    setChecking(true);
    try {
      setReport(await checkUpdates());
    } catch {
      /* 读失败就把上一次的结果留着，总比清空好 */
    } finally {
      setChecking(false);
    }
  };

  const fixAll = async () => {
    if (!report) return;
    setApplying(true);
    setOutput(null);
    try {
      const out = await applyUpdates(report.packages.map((p) => p.name));
      setOutput(out);
      load();
    } catch (e) {
      setOutput(`${t('system.patch_fail')}: ${e instanceof Error ? e.message : ''}`);
    } finally {
      setApplying(false);
      setConfirming(false);
    }
  };

  const security = report?.packages.filter((p) => p.security) ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${t('system.title')} / ${t('system.updates')}`}
        subtitle={report?.distro ? `${report.distro}${report.manager ? ` · ${report.manager}` : ''}` : undefined}
        actions={
          <Button variant="outline" size="sm" onClick={recheck} disabled={checking}>
            <RefreshCw className={cn(checking && 'animate-spin')} />
            {checking ? t('system.checking') : t('system.recheck')}
          </Button>
        }
      />

      {loading ? (
        <Skeleton className="h-40 w-full rounded-2xl" />
      ) : !report?.supported ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Terminal className="mx-auto mb-3 size-8 text-muted-foreground opacity-40" />
            <p className="text-sm text-muted-foreground">{report?.message || t('system.patch_unsupported')}</p>
            {/* 说清"为什么不行"，否则用户只会觉得功能坏了。 */}
            <p className="mt-2 text-xs text-muted-foreground/70">
              {t('system.patch_unsupported_hint')}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { k: t('system.patch_security'), v: report.security, tone: report.security > 0 ? 'warn' : 'ok' },
              { k: t('system.patch_total'), v: report.total, tone: 'ok' },
              { k: t('system.patch_checked'), v: report.checked_at, tone: 'ok' },
            ].map((row) => (
              <div key={row.k} className="rounded-xl border border-border/60 px-3.5 py-3">
                <p className="text-xs text-muted-foreground">{row.k}</p>
                <p
                  className={cn(
                    'mt-1 font-mono text-lg tabular-nums',
                    row.tone === 'warn' && 'text-amber-600 dark:text-amber-400',
                  )}
                >
                  {row.v}
                </p>
              </div>
            ))}
            <div className="flex items-center rounded-xl border border-border/60 px-3.5 py-3">
              <Button
                className="w-full"
                size="sm"
                variant={security.length > 0 ? 'default' : 'secondary'}
                disabled={security.length === 0}
                onClick={() => setConfirming(true)}
              >
                <ShieldCheck />
                {t('system.patch_fix')}
              </Button>
            </div>
          </div>

          {output && (
            <pre className="max-h-64 overflow-auto rounded-xl border border-border/60 px-4 py-3 font-mono text-xs text-muted-foreground">
              {output}
            </pre>
          )}

          <Card>
            <CardContent className="p-0">
              {report.packages.length === 0 ? (
                <div className="px-4 py-12 text-center">
                  <Check className="mx-auto mb-3 size-8 text-emerald-500/70" />
                  <p className="text-sm text-muted-foreground">{t('system.patch_none')}</p>
                </div>
              ) : (
                <div className="divide-y divide-border/60">
                  {report.packages.map((p) => (
                    <div key={p.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                      <span className="min-w-0 flex-1 truncate font-mono text-sm">{p.name}</span>
                      {p.security && (
                        <Badge variant="secondary" className="shrink-0">
                          {t('system.patch_security_tag')}
                        </Badge>
                      )}
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {p.candidate}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* 装补丁会真实改动主机上的软件包，所以要二次确认，并且把"装哪几个"列出来。 */}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('system.patch_confirm_title')}</DialogTitle>
            <DialogDescription>{t('system.patch_confirm_desc')}</DialogDescription>
          </DialogHeader>
          <div className="flex gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-muted-foreground">
              {t('system.patch_confirm_body', { count: security.length })}
            </p>
          </div>
          <div className="max-h-40 overflow-auto rounded-xl border border-border/60 px-3 py-2 font-mono text-xs text-muted-foreground">
            {security.map((p) => p.name).join('\n')}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirming(false)} disabled={applying}>
              {t('sites.cancel')}
            </Button>
            <Button onClick={fixAll} disabled={applying}>
              {applying ? t('system.patching') : t('system.patch_confirm_yes')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
