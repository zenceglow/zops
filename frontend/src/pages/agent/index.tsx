import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  KeyRound,
  Link2,
  MoreVertical,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { Card, CardContent } from '../../components/ui/card';
import { Skeleton } from '../../components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { cn } from '../../lib/utils';
import { copyText } from '../../lib/clipboard';
import { toast } from '../../components/ui/sonner';
import useMcpConnections from '../../stores/mcp-connections.store';
import { CapabilityGrid, type AgentTool } from './_components/capability-grid';
import {
  createToken,
  getAgentOps,
  getAgentTools,
  listTokens,
  revokeToken,
  type AgentOp,
  type ApiTokenInfo,
} from './_api';

type ClientKind = 'codex' | 'json';

function configFor(client: ClientKind, url: string, token: string): string {
  if (client === 'codex') {
    return `# ~/.codex/config.toml
[mcp_servers.zops]
url = "${url}"
http_headers = { Authorization = "Bearer ${token}" }`;
  }
  return `{
  "mcpServers": {
    "zops": {
      "url": "${url}",
      "headers": { "Authorization": "Bearer ${token}" }
    }
  }
}`;
}

/** 审计里是 UTC（SQLite `datetime('now')`），显示前换成本地时间。 */
function fmtTime(s: string): string {
  const d = new Date(`${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

function isWithin24h(at: string): boolean {
  const d = new Date(`${at.replace(' ', 'T')}Z`).getTime();
  return Number.isFinite(d) && Date.now() - d < 86_400_000;
}

/**
 * 接入 Codex / MCP。
 *
 * 一页三段：**状态一览 → 连接（主角）→ 活动（佐证）**。
 *
 * 一个连接 = 一个令牌 = 一张卡。卡片只回答四件事：叫什么、能给 agent 什么权限、
 * 现在什么状态、怎么复制走。配置正文（那段 TOML）不进卡面 —— 那是"要看细节时"
 * 才展开的东西，铺在卡上只会把真正重要的状态挤没。
 *
 * 令牌明文只在这台浏览器留底（加密存储，见 mcp-connections.store）：服务端存的
 * 始终只有哈希，但卡片必须随时能复制，否则刷新一次就得重建连接。
 */
export default function McpPage() {
  const { t } = useTranslation();
  const [tokens, setTokens] = useState<ApiTokenInfo[]>([]);
  const [tools, setTools] = useState<AgentTool[]>([]);
  const [ops, setOps] = useState<AgentOp[]>([]);
  const [loading, setLoading] = useState(true);
  const [showOps, setShowOps] = useState(false);
  const [opsFilter, setOpsFilter] = useState<'all' | 'write'>('all');

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [scope, setScope] = useState('write');
  const [client, setClient] = useState<ClientKind>('codex');
  const [busy, setBusy] = useState(false);
  /** 刚拿到的那把钥匙：令牌只显示这一次，同一个弹窗内接着展示结果。 */
  const [fresh, setFresh] = useState<(ApiTokenInfo & { token: string }) | null>(null);
  const [viewing, setViewing] = useState<ApiTokenInfo | null>(null);
  const [viewClient, setViewClient] = useState<ClientKind>('codex');

  const remembered = useMcpConnections((s) => s.tokens);
  const remember = useMcpConnections((s) => s.remember);
  const forget = useMcpConnections((s) => s.forget);

  const origin = window.location.origin;
  const mcpUrl = `${origin}/api/ops/mcp`;
  const tokenOf = (c: ApiTokenInfo) => remembered[c.id] ?? '';

  const refresh = useCallback(async () => {
    const res = await listTokens();
    if (res.success && res.data) setTokens(res.data);
  }, []);

  useEffect(() => {
    refresh()
      .catch(() => toast.error(t('mcp.load_failed')))
      .finally(() => setLoading(false));
    void getAgentTools()
      .then(setTools)
      .catch(() => setTools([]));
    void getAgentOps()
      .then(setOps)
      .catch(() => setOps([]));
  }, [refresh]);

  const openCreate = () => {
    setName('');
    setScope('write');
    setClient('codex');
    setFresh(null);
    setCreating(true);
  };

  const create = async () => {
    setBusy(true);
    try {
      const res = await createToken({ name: name.trim() || t('mcp.new'), scope });
      if (!res.success || !res.data) throw new Error(res.message || t('deploy.create_failed'));
      remember(res.data.id, res.data.token);
      setFresh(res.data);
      await refresh();
    } catch (e) {
      toast.error(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 本机没留底的那把钥匙：换一把同名的。
   *
   * 令牌明文取不出来（服务端只有哈希），所以唯一干净的出口是重发 —— 而不是让用户
   * 自己去 ⋯ 里删掉、再从头建一个。换完直接把新令牌摆在弹窗里让他复制。
   */
  const rebuild = async (conn: ApiTokenInfo) => {
    if (!window.confirm(t('mcp.rebuild_confirm', { name: conn.name }))) return;
    try {
      const gone = await revokeToken(conn.id);
      if (!gone.success) throw new Error(gone.message || t('mcp.disconnect'));
      forget(conn.id);
      const res = await createToken({ name: conn.name, scope: conn.scope });
      if (!res.success || !res.data) throw new Error(res.message || t('deploy.create_failed'));
      remember(res.data.id, res.data.token);
      setFresh(res.data);
      setViewing(null);
      await refresh();
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const remove = async (conn: ApiTokenInfo) => {
    if (!window.confirm(t('mcp.disconnect_confirm', { name: conn.name }))) return;
    try {
      const res = await revokeToken(conn.id);
      if (!res.success) throw new Error(res.message || t('mcp.disconnect'));
      forget(conn.id);
      setViewing(null);
      await refresh();
      toast.success(t('mcp.disconnected'));
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const copy = async (text: string) => {
    if (await copyText(text)) toast.success(t('mcp.copied'));
    else toast.error(t('mcp.copy_failed'));
  };

  const activeCount = tokens.filter((c) => !!c.last_used_at).length;
  const calls24h = ops.filter((o) => isWithin24h(o.at)).length;
  const visibleOps = opsFilter === 'write' ? ops.filter((o) => o.level === 'write') : ops;
  const lastOp = ops[0];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('mcp.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('mcp.subtitle')}</p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus />
          {t('mcp.new')}
        </Button>
      </div>

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : tokens.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <Link2 className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('mcp.empty')}</p>
            <Button size="sm" variant="outline" onClick={openCreate}>
              {t('mcp.new')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ① 状态一览：不用点进去就知道这几把钥匙现在什么情况 */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-muted/40 px-3.5 py-2 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            {t('mcp.summary', {
              conns: tokens.length,
              active: activeCount,
              calls: calls24h,
            })}
          </div>

          {/* ② 连接：这一页的主角 */}
          <div className="grid gap-3 sm:grid-cols-2">
            {tokens.map((conn) => {
              const plain = tokenOf(conn);
              const stale = !plain;
              const used = !!conn.last_used_at;
              return (
                <div
                  key={conn.id}
                  className={cn(
                    'flex flex-col rounded-2xl bg-card p-4 ring-1 transition-colors',
                    stale ? 'ring-amber-500/40' : 'ring-border/60 hover:ring-border',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'size-2 shrink-0 rounded-full',
                            stale ? 'bg-amber-500' : used ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                          )}
                        />
                        <p className="truncate text-sm font-medium">{conn.name}</p>
                        <Badge
                          variant={conn.scope === 'write' ? 'default' : 'secondary'}
                          className="h-4 shrink-0 px-1 text-[10px]"
                        >
                          {conn.scope === 'write' ? t('mcp.scope_write') : t('mcp.scope_read')}
                        </Badge>
                      </div>
                      <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <KeyRound className="size-3" />
                        <span className="font-mono">{conn.prefix}…</span>
                        <span>·</span>
                        {used
                          ? t('mcp.used', { t: fmtTime(conn.last_used_at!) })
                          : t('mcp.never_used')}
                      </p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={t('logs.more')}
                          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <MoreVertical className="size-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setViewing(conn)}>
                          {t('mcp.view')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => void remove(conn)}
                        >
                          <Trash2 className="size-3.5" />
                          {t('mcp.disconnect')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  {stale && (
                    <p className="mt-3 flex items-start gap-1.5 text-[11px] text-amber-600">
                      <AlertTriangle className="mt-px size-3 shrink-0" />
                      {t('mcp.no_local')}
                    </p>
                  )}

                  <div className="mt-4 flex items-center gap-2">
                    {stale ? (
                      <Button size="sm" className="flex-1" onClick={() => void rebuild(conn)}>
                        <RefreshCw />
                        {t('mcp.rebuild')}
                      </Button>
                    ) : (
                      /* 主按钮一下就是最常见的用法（Codex）；要别的写法走右边那个箭头。 */
                      <div className="flex flex-1">
                        <Button
                          size="sm"
                          className="flex-1 rounded-r-none"
                          onClick={() => void copy(configFor('codex', mcpUrl, plain))}
                        >
                          <Copy />
                          {t('mcp.copy')}
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="sm" className="rounded-l-none border-l border-primary-foreground/20 px-2">
                              <ChevronDown />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-56">
                            <DropdownMenuItem
                              onClick={() => void copy(configFor('codex', mcpUrl, plain))}
                            >
                              {t('mcp.codex_label')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => void copy(configFor('json', mcpUrl, plain))}
                            >
                              {t('mcp.json_label')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ③ 活动：默认一行，点开才是完整流水 */}
      <div className="rounded-2xl bg-card px-4 py-3 ring-1 ring-border/60">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            onClick={() => setShowOps((v) => !v)}
            className="flex items-center gap-2 text-sm font-medium"
          >
            <ChevronDown className={cn('size-4 transition-transform', showOps && 'rotate-180')} />
            {t('mcp.ops_title')}
          </button>
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {lastOp
              ? t('mcp.ops_recent', { who: lastOp.actor, tool: lastOp.tool })
              : t('mcp.ops_empty')}
          </span>
          {showOps && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant={opsFilter === 'all' ? 'default' : 'outline'}
                onClick={() => setOpsFilter('all')}
              >
                {t('mcp.ops_all')}
              </Button>
              <Button
                size="sm"
                variant={opsFilter === 'write' ? 'default' : 'outline'}
                onClick={() => setOpsFilter('write')}
              >
                {t('mcp.ops_writes')}
              </Button>
            </div>
          )}
        </div>

        {showOps && (
          <ul className="mt-3 divide-y divide-border/60 border-t border-border/60">
            {visibleOps.length === 0 ? (
              <li className="py-6 text-center text-xs text-muted-foreground">
                {t('mcp.ops_empty')}
              </li>
            ) : (
              visibleOps.map((op) => (
                <li key={op.id} className="flex items-center gap-3 py-2 text-xs">
                  <span className="w-36 shrink-0 text-muted-foreground">{fmtTime(op.at)}</span>
                  <span className="w-24 shrink-0 truncate" title={op.actor}>
                    {op.actor}
                  </span>
                  <Badge
                    variant={op.level === 'write' ? 'default' : 'secondary'}
                    className="h-4 shrink-0 px-1 text-[10px]"
                  >
                    {op.level === 'write' ? t('mcp.ops_write') : t('mcp.ops_read')}
                  </Badge>
                  <span className="shrink-0 font-mono">{op.tool}</span>
                  {!op.ok && (
                    <span className="shrink-0 text-destructive">{t('mcp.ops_failed')}</span>
                  )}
                  <span className="ml-auto hidden min-w-0 truncate text-[11px] text-muted-foreground sm:block">
                    {op.detail}
                  </span>
                </li>
              ))
            )}
          </ul>
        )}
      </div>

      {/* ── 弹窗：新建 / 刚创建（同一个弹窗的两个阶段） ── */}
      <Dialog
        open={creating}
        onOpenChange={(v) => {
          setCreating(v);
          if (!v) setFresh(null);
        }}
      >
        <DialogContent className="sm:max-w-xl">
          {fresh ? (
            <>
              <DialogHeader>
                <DialogTitle>{t('mcp.created_title')}</DialogTitle>
                <DialogDescription>{t('mcp.created_desc')}</DialogDescription>
              </DialogHeader>
              <ConfigBlock
                client={client}
                url={mcpUrl}
                token={fresh.token}
                onCopy={copy}
                onClient={setClient}
              />
              <DialogFooter>
                <Button
                  onClick={() => {
                    setFresh(null);
                    setCreating(false);
                  }}
                >
                  <Check />
                  {t('mcp.done')}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{t('mcp.create_title')}</DialogTitle>
                <DialogDescription>{t('mcp.create_desc')}</DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="conn-name">{t('mcp.name')}</Label>
                  <Input
                    id="conn-name"
                    value={name}
                    autoFocus
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('mcp.name_placeholder')}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t('mcp.permissions')}</Label>
                  <div className="flex gap-2">
                    {[
                      { id: 'read', label: t('mcp.scope_read'), desc: t('mcp.scope_read_desc') },
                      { id: 'write', label: t('mcp.scope_write'), desc: t('mcp.scope_write_desc') },
                    ].map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setScope(s.id)}
                        className={cn(
                          'flex-1 rounded-xl px-3 py-2 text-left ring-1 transition-colors',
                          scope === s.id ? 'bg-primary/5 ring-primary/50' : 'ring-border/60 hover:bg-muted/50',
                        )}
                      >
                        <span className="block text-sm">{s.label}</span>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                          {s.desc}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>{t('mcp.client')}</Label>
                  <div className="flex gap-2">
                    {(
                      [
                        { id: 'codex', label: t('mcp.codex_label') },
                        { id: 'json', label: t('mcp.json_label') },
                      ] as { id: ClientKind; label: string }[]
                    ).map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setClient(c.id)}
                        className={cn(
                          'flex-1 rounded-xl px-3 py-2 text-left text-xs ring-1 transition-colors',
                          client === c.id ? 'bg-primary/5 ring-primary/50' : 'ring-border/60 hover:bg-muted/50',
                        )}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setCreating(false)}>
                  {t('mcp.cancel')}
                </Button>
                <Button onClick={create} disabled={busy}>
                  {t('mcp.create_and_copy')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── 弹窗：连接详情（配置正文 + 它能干什么） ── */}
      <Dialog open={!!viewing} onOpenChange={(v) => !v && setViewing(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{viewing?.name}</DialogTitle>
            <DialogDescription>
              {viewing && tokenOf(viewing) ? t('mcp.config_ready') : t('mcp.config_missing')}
            </DialogDescription>
          </DialogHeader>
          {viewing && tokenOf(viewing) ? (
            <ConfigBlock
              client={viewClient}
              url={mcpUrl}
              token={tokenOf(viewing)}
              onCopy={copy}
              onClient={setViewClient}
            />
          ) : (
            viewing && (
              <Button className="w-full" onClick={() => void rebuild(viewing)}>
                <RefreshCw />
                {t('mcp.rebuild')}
              </Button>
            )
          )}
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('mcp.capabilities')}</p>
            <p className="text-[11px] text-muted-foreground">{t('mcp.resources_hint')}</p>
            <CapabilityGrid tools={tools} />
          </div>
          <DialogFooter>
            <Button onClick={() => setViewing(null)}>{t('mcp.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 配置正文。两种客户端各一份，用上面的切换按钮换。 */
function ConfigBlock({
  client,
  url,
  token,
  onCopy,
  onClient,
}: {
  client: ClientKind;
  url: string;
  token: string;
  onCopy: (text: string) => void | Promise<void>;
  onClient: (c: ClientKind) => void;
}) {
  const { t } = useTranslation();
  const text = configFor(client, url, token);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {(
          [
            { id: 'codex', label: t('mcp.codex_label') },
            { id: 'json', label: t('mcp.json_label') },
          ] as { id: ClientKind; label: string }[]
        ).map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onClient(c.id)}
            className={cn(
              'rounded-lg px-2 py-1 text-[11px] ring-1 transition-colors',
              client === c.id ? 'bg-primary/5 ring-primary/50' : 'ring-border/60 hover:bg-muted/50',
            )}
          >
            {c.label}
          </button>
        ))}
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          onClick={() => void onCopy(text)}
        >
          <Copy />
          {t('logs.copy')}
        </Button>
      </div>
      <pre className="max-w-full overflow-x-auto rounded-xl bg-muted/40 p-3 font-mono text-xs leading-relaxed">
        {text}
      </pre>
    </div>
  );
}
