import { useTranslation } from 'react-i18next';
import {
  Globe,
  Play,
  Square,
  RotateCw,
  Save,
  Undo2,
  FileText,
  Eye,
  Download,
  Plus,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { Badge } from '../../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
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
import { DirectiveRow } from './_components/directive-row';

export default function SitesPage() {
  const { t } = useTranslation();
  const s = useSites();

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
            {s.msg && <Badge variant="secondary">{s.msg}</Badge>}
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
          {s.msg && <Badge variant="secondary">{s.msg}</Badge>}
          <Button size="sm" onClick={() => s.setShowAdd(true)}>
            <Plus />
            {t('sites.add_site')}
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 py-4">
          <Badge variant={s.status.running ? 'default' : 'secondary'}>
            {s.status.running ? t('sites.running') : t('sites.stopped')}
          </Badge>
          <span className="text-xs text-muted-foreground font-mono">
            PID {s.status.pid ?? '-'}
          </span>
          <span className="text-xs text-muted-foreground">{s.status.version}</span>
          <span className="text-xs text-muted-foreground truncate max-w-48 font-mono">
            {s.status.caddyfile_path}
          </span>
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={s.status.running}
              onClick={() => s.serverAction('start')}
            >
              <Play />
              {t('sites.start')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!s.status.running}
              onClick={() => s.serverAction('stop')}
            >
              <Square />
              {t('sites.stop')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!s.status.running}
              onClick={() => s.serverAction('reload')}
            >
              <RotateCw />
              {t('sites.reload')}
            </Button>
          </div>
        </CardContent>
      </Card>

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

      <Tabs value={s.tab} onValueChange={s.setTab}>
        <TabsList>
          <TabsTrigger value="visual">
            <Eye className="size-3.5" />
            {t('sites.visual')}
          </TabsTrigger>
          <TabsTrigger value="editor">
            <FileText className="size-3.5" />
            {t('sites.editor')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="visual" className="space-y-4 mt-4">
          {s.config?.parsed.preamble && (
            <Card>
              <CardHeader>
                <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
                  {t('sites.global_config')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="text-sm whitespace-pre-wrap font-mono">
                  {s.config.parsed.preamble}
                </pre>
              </CardContent>
            </Card>
          )}
          {(!s.config || s.config.parsed.sites.length === 0) && (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                <Globe className="size-8 mx-auto mb-3 opacity-40" />
                {t('sites.no_sites')}
              </CardContent>
            </Card>
          )}
          {s.config?.parsed.sites.map((site, i) => (
            <Card key={i}>
              <CardHeader className="flex flex-row items-center gap-2 space-y-0 border-b py-3">
                <span className="size-2 rounded-full bg-primary" />
                <CardTitle className="font-mono text-sm">{site.addr}</CardTitle>
              </CardHeader>
              <CardContent className="p-0 divide-y">
                {site.directives.length === 0 && (
                  <div className="px-4 py-3 text-xs text-muted-foreground">—</div>
                )}
                {site.directives.map((d, j) => (
                  <DirectiveRow key={j} directive={d} />
                ))}
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="editor" className="mt-4 space-y-3">
          {s.config && (
            <>
              <Textarea
                value={s.rawEditor}
                onChange={(e) => s.setRawEditor(e.target.value)}
                className="min-h-[55vh] font-mono text-sm"
                spellCheck={false}
              />
              <div className="flex gap-3">
                <Button onClick={s.saveConfig}>
                  <Save />
                  {t('sites.save_config')}
                </Button>
                <Button variant="secondary" onClick={() => s.setRawEditor(s.config!.raw)}>
                  <Undo2 />
                  {t('sites.reset')}
                </Button>
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
