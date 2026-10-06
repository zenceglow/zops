import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Globe,
  Save,
  Undo2,
  FileText,
  Download,
  Plus,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Card, CardContent, CardTitle } from '../../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { Skeleton } from '../../components/ui/skeleton';
import { useSites } from './_hooks/use-sites';
import { CaddyfileEditor } from './_components/caddyfile-editor';
import { GatewayLogDialog } from './_components/gateway-log-dialog';
import { GatewayStatusCard } from './_components/gateway-status-card';
import { SiteListItem } from './_components/site-list-item';
import { VersionHistoryDialog } from './_components/version-history-dialog';
import { isPanelHost, usePanelPrefs } from '../../stores/panel-prefs';

export default function SitesPage() {
  const { t } = useTranslation();
  const panelDomain = usePanelPrefs((s) => s.domain);
  const loadPrefs = usePanelPrefs((s) => s.load);
  useEffect(() => {
    void loadPrefs();
  }, [loadPrefs]);
  const s = useSites();
  const [showLogs, setShowLogs] = useState(false);
  /** 等着确认删除的那个域名。 */
  const [deleting, setDeleting] = useState<string | null>(null);

  if (!s.status) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">{t('sites.title')}</h1>
        <Skeleton className="h-6 w-32" />
      </div>
    );
  }

  if (!s.status.installed) {
    return (
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-6">{t('sites.title')}</h1>
        <Card className="max-w-lg mx-auto mt-12">
          <CardContent className="pt-8 text-center space-y-4">
            <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-primary/10">
              <Globe className="size-8 text-primary" />
            </div>
            <CardTitle>{t('sites.install_prompt_title')}</CardTitle>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t('sites.install_prompt_desc')}
            </p>
            <Button onClick={s.handleInstall} disabled={s.installing}>
              {s.installing ? (
                t('sites.install_doing')
              ) : (
                <>
                  <Download />
                  {t('sites.install_btn')}
                </>
              )}
            </Button>
            <p className="text-xs text-muted-foreground">{t('sites.install_desc')}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{t('sites.title')}</h1>
        <div className="flex items-center gap-2">
          {s.mode === 'list' ? (
            <>
              <Button size="sm" variant="outline" onClick={() => s.setMode('editor')}>
                <FileText />
                {t('sites.edit_config')}
              </Button>
              <Button size="sm" onClick={() => s.setShowAdd(true)}>
                <Plus />
                {t('sites.add_site')}
              </Button>
            </>
          ) : (
            <>
              <VersionHistoryDialog
                versions={s.versions}
                loading={s.loadingVersions}
                onOpen={s.loadVersions}
                onRestore={s.restoreVersion}
              />
              <Button size="sm" variant="outline" onClick={() => s.saveConfig()}>
                <Save />
                {t('sites.save_config')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => s.setMode('list')}>
                <ArrowLeft />
                {t('sites.back_to_list')}
              </Button>
            </>
          )}
        </div>
      </div>

      <GatewayStatusCard
        status={s.status}
        busy={s.acting}
        onAction={s.serverAction}
        onShowLogs={() => setShowLogs(true)}
      />

      <GatewayLogDialog open={showLogs} onOpenChange={setShowLogs} />

      {/* 删站点是不可逆的（虽然能从历史版本回滚），先问一句。 */}
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('sites.delete_title', { addr: deleting ?? '' })}</DialogTitle>
            <DialogDescription>
              {deleting && isPanelHost(deleting, panelDomain)
                ? t('sites.delete_panel_desc')
                : t('sites.delete_desc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeleting(null)}>
              {t('sites.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const addr = deleting;
                setDeleting(null);
                if (addr) void s.removeSite(addr);
              }}
            >
              {t('sites.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 这里原本是 modal={false}（怕 Select 的浮层和 Dialog 打架）。但非模态的
          Radix Dialog 压根不渲染蒙层，对话框就和页面糊在一起、看不出是浮在上面的。
          Select 点在 Dialog 里的场景 ui/dialog 已经专门处理过（点浮层不会误关），
          所以回到默认的模态即可。 */}
      <Dialog open={s.showAdd} onOpenChange={s.setShowAdd}>
        <DialogContent
          className="sm:max-w-md"
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>{t('sites.add_site')}</DialogTitle>
            <DialogDescription>{t('sites.add_site_desc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t('sites.domain')}</Label>
              <Input
                value={s.newDomain}
                onChange={(e) => s.setNewDomain(e.target.value)}
                placeholder={t('sites.domain_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('sites.type')}</Label>
              <Select
                value={s.newType}
                onValueChange={(v) => s.setNewType(v as 'proxy' | 'static')}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="proxy">{t('sites.reverse_proxy')}</SelectItem>
                  <SelectItem value="static">{t('sites.static_file')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('sites.target')}</Label>
              <Input
                value={s.newTarget}
                onChange={(e) => s.setNewTarget(e.target.value)}
                placeholder={t('sites.target_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('sites.template')}</Label>
              <Select
                value={s.newTemplate}
                onValueChange={(v) => s.setNewTemplate(v as 'standard' | 'simple')}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">{t('sites.template_standard')}</SelectItem>
                  <SelectItem value="simple">{t('sites.template_simple')}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t('sites.template_hint')}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => s.setShowAdd(false)}>
              {t('sites.cancel')}
            </Button>
            <Button onClick={s.handleAddSite} disabled={!s.newDomain || !s.newTarget}>
              {t('sites.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {s.mode === 'list' ? (
        <div className="space-y-3">
          {(!s.config || s.config.parsed.sites.length === 0) && (
            <Card>
              <CardContent className="py-10 text-center text-muted-foreground">
                <Globe className="size-8 mx-auto mb-3 opacity-40" />
                <p>{t('sites.no_sites')}</p>
                <p className="mt-1 text-xs opacity-70">{t('sites.no_sites_hint')}</p>
              </CardContent>
            </Card>
          )}
          {s.config?.parsed.sites.map((site, i) => (
            <SiteListItem key={i} site={site} onDelete={setDeleting} />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {s.config?.parsed.preamble && (
            <div>
              <p className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">
                {t('sites.global_config')}
              </p>
              <pre className="overflow-x-auto rounded-xl border border-border/60 px-3 py-2.5 font-mono text-xs text-muted-foreground">
                {s.config.parsed.preamble}
              </pre>
            </div>
          )}
          {s.config && <CaddyfileEditor value={s.rawEditor} onChange={s.setRawEditor} />}
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={() => s.setRawEditor(s.config?.raw ?? '')}>
              <Undo2 />
              {t('sites.reset')}
            </Button>
            <p className="text-xs text-muted-foreground">{t('sites.editor_hint')}</p>
          </div>
        </div>
      )}
    </div>
  );
}
