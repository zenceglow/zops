import React, { useEffect, useState, useCallback } from 'react';
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
  Server,
  ExternalLink,
  FolderOpen,
  ArrowRight,
  Send,
  FileCode,
  FolderTree,
  Plus,
} from 'lucide-react';
import { apiGet, apiPost } from '../../lib/api';
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

interface GatewayStatus {
  installed: boolean;
  running: boolean;
  version: string;
  pid: number | null;
  bin_path: string;
  caddyfile_path: string;
}

interface SiteEntry {
  addr: string;
  directives: Directive[];
}

interface Directive {
  key: string;
  args: string[];
  sub: Directive[];
}

interface ParsedConfig {
  sites: SiteEntry[];
  preamble: string;
}

interface GatewayConfig {
  raw: string;
  parsed: ParsedConfig;
}

const GW = '/api/ops/gateway';

export default function Sites() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [rawEditor, setRawEditor] = useState('');
  const [tab, setTab] = useState('visual');
  const [msg, setMsg] = useState('');
  const [installing, setInstalling] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [newType, setNewType] = useState<'proxy' | 'static'>('proxy');
  const [newTarget, setNewTarget] = useState('');

  const fetchAll = useCallback(() => {
    apiGet<GatewayStatus>(`${GW}/server/status`).then(setStatus).catch(() => {});
    apiGet<GatewayConfig>(`${GW}/file`)
      .then((d) => {
        setConfig(d);
        setRawEditor(d.raw);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const serverAction = useCallback(
    async (action: string) => {
      const res = await apiPost(`${GW}/server/${action}`);
      if (res?.ok) {
        setMsg(t(`sites.${action}_success`));
        setTimeout(() => fetchAll(), 500);
      } else {
        setMsg(t('sites.action_fail'));
      }
    },
    [fetchAll, t],
  );

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    setMsg(t('sites.install_doing'));
    try {
      const res = await apiPost(`${GW}/server/install`);
      if (res?.ok) {
        setMsg(t('sites.install_success'));
        fetchAll();
      } else {
        setMsg(t('sites.install_fail'));
      }
    } catch {
      setMsg(t('sites.install_fail'));
    }
    setInstalling(false);
  }, [fetchAll, t]);

  const saveConfig = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${GW}/file`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ raw: rawEditor }),
      });
      if (!res.ok) {
        const errText = await res.text();
        setMsg(`${t('sites.save_fail')}: ${errText}`);
        return;
      }
      setMsg(t('sites.saved_reload'));
      fetchAll();
    } catch {
      setMsg(t('sites.save_fail'));
    }
  }, [rawEditor, fetchAll, t]);

  const handleAddSite = useCallback(() => {
    if (!newDomain || !newTarget) return;
    const line =
      newType === 'proxy'
        ? `${newDomain} {\n    reverse_proxy ${newTarget}\n}`
        : `${newDomain} {\n    root * ${newTarget}\n    file_server\n}`;

    const updated = (rawEditor || config?.raw || '').replace(/\n*$/, '') + '\n\n' + line + '\n';
    setRawEditor(updated);
    setNewDomain('');
    setNewTarget('');
    setShowAdd(false);
    setMsg(t('sites.saved_reload'));
  }, [newDomain, newType, newTarget, rawEditor, config, t]);

  if (!status) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">{t('sites.title')}</h1>
        <Skeleton className="h-6 w-32" />
      </div>
    );
  }

  if (!status.installed) {
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
            <Button onClick={handleInstall} disabled={installing}>
              {installing ? (
                t('sites.install_doing')
              ) : (
                <>
                  <Download />
                  {t('sites.install_btn')}
                </>
              )}
            </Button>
            <p className="text-xs text-muted-foreground">{t('sites.install_desc')}</p>
            {msg && <Badge variant="secondary">{msg}</Badge>}
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
          {msg && <Badge variant="secondary">{msg}</Badge>}
          <Button size="sm" onClick={() => setShowAdd(true)}>
            <Plus />
            {t('sites.add_site')}
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 py-4">
          <Badge variant={status.running ? 'default' : 'secondary'}>
            {status.running ? t('sites.running') : t('sites.stopped')}
          </Badge>
          <span className="text-xs text-muted-foreground font-mono">
            PID {status.pid ?? '-'}
          </span>
          <span className="text-xs text-muted-foreground">{status.version}</span>
          <span className="text-xs text-muted-foreground truncate max-w-48 font-mono">
            {status.caddyfile_path}
          </span>
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={status.running}
              onClick={() => serverAction('start')}
            >
              <Play />
              {t('sites.start')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!status.running}
              onClick={() => serverAction('stop')}
            >
              <Square />
              {t('sites.stop')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!status.running}
              onClick={() => serverAction('reload')}
            >
              <RotateCw />
              {t('sites.reload')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* modal={false}: Select inside Dialog — avoid nested portal / scroll lock (yueqixing-oms) */}
      <Dialog open={showAdd} onOpenChange={setShowAdd} modal={false}>
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
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                placeholder={t('sites.domain_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('sites.type')}</Label>
              <Select
                value={newType}
                onValueChange={(v) => setNewType(v as 'proxy' | 'static')}
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
                value={newTarget}
                onChange={(e) => setNewTarget(e.target.value)}
                placeholder={t('sites.target_placeholder')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>
              {t('sites.cancel')}
            </Button>
            <Button onClick={handleAddSite} disabled={!newDomain || !newTarget}>
              {t('sites.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Tabs value={tab} onValueChange={setTab}>
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
          {config?.parsed.preamble && (
            <Card>
              <CardHeader>
                <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">
                  {t('sites.global_config')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="text-sm whitespace-pre-wrap font-mono">
                  {config.parsed.preamble}
                </pre>
              </CardContent>
            </Card>
          )}
          {(!config || config.parsed.sites.length === 0) && (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                <Globe className="size-8 mx-auto mb-3 opacity-40" />
                {t('sites.no_sites')}
              </CardContent>
            </Card>
          )}
          {config?.parsed.sites.map((site, i) => (
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
          {config && (
            <>
              <Textarea
                value={rawEditor}
                onChange={(e) => setRawEditor(e.target.value)}
                className="min-h-[55vh] font-mono text-sm"
                spellCheck={false}
              />
              <div className="flex gap-3">
                <Button onClick={saveConfig}>
                  <Save />
                  {t('sites.save_config')}
                </Button>
                <Button variant="secondary" onClick={() => setRawEditor(config.raw)}>
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

function DirectiveRow({ directive }: { directive: Directive }) {
  const iconMap: Record<string, { icon: React.ComponentType<{ className?: string }>; label: string }> = {
    reverse_proxy: { icon: ExternalLink, label: 'Reverse Proxy' },
    root: { icon: FolderOpen, label: 'Root' },
    file_server: { icon: FileText, label: 'File Server' },
    redir: { icon: ArrowRight, label: 'Redirect' },
    respond: { icon: Send, label: 'Respond' },
    encode: { icon: FileCode, label: 'Encode' },
    handle_path: { icon: FolderTree, label: 'Handle Path' },
  };
  const meta = iconMap[directive.key];
  const Icon = meta?.icon || Server;

  return (
    <div className="px-4 py-2.5 hover:bg-muted/30 transition-colors">
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs text-muted-foreground font-mono">{directive.key}</span>
        <span className="text-sm font-medium">{meta?.label || directive.key}</span>
        {directive.args.length > 0 && (
          <span className="font-mono text-sm text-muted-foreground truncate">
            {directive.args.join(' ')}
          </span>
        )}
      </div>
      {directive.sub.length > 0 && (
        <div className="ml-5 mt-1 border-l pl-3 space-y-1">
          {directive.sub.map((s, i) => (
            <DirectiveRow key={i} directive={s} />
          ))}
        </div>
      )}
    </div>
  );
}
