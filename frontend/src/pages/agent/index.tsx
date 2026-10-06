import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Copy,
  KeyRound,
  Link2,
  MoreVertical,
  Plus,
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
  getAgentTools,
  listTokens,
  revokeToken,
  type ApiTokenInfo,
} from './_api';

/**
 * 接入 Codex / MCP。
 *
 * 一个**连接 = 一个令牌 = 一张卡**。卡片上就两件事：这个连接是什么权限、以及
 * "复制连接方式"——复制出来的那段配置直接粘进 agent 就能用，里面已经带上这个
 * 连接的令牌。要停掉就删卡。
 *
 * 令牌明文只在这台浏览器留底（加密存储，见 mcp-connections.store）：服务端存的
 * 始终只有哈希，但卡片必须随时能复制 —— 否则刷新一次就得重建连接，那就又难用了。
 */
export default function McpPage() {
  const [tokens, setTokens] = useState<ApiTokenInfo[]>([]);
  const [tools, setTools] = useState<AgentTool[]>([]);
  const [loading, setLoading] = useState(true);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [scope, setScope] = useState('write');
  const [busy, setBusy] = useState(false);
  /** 刚建好的连接：令牌只显示这一次，所以单独用一个弹窗接住它。 */
  const [fresh, setFresh] = useState<ApiTokenInfo & { token: string } | null>(null);
  const [viewing, setViewing] = useState<ApiTokenInfo | null>(null);

  const remembered = useMcpConnections((s) => s.tokens);
  const remember = useMcpConnections((s) => s.remember);
  const forget = useMcpConnections((s) => s.forget);

  const origin = window.location.origin;
  const mcpUrl = `${origin}/api/ops/mcp`;
  /** 本机留底里没有的（改版前建的），配置里用占位符，并提示删掉重建。 */
  const tokenOf = (t: ApiTokenInfo) => remembered[t.id] ?? '';

  const refresh = useCallback(async () => {
    const res = await listTokens();
    if (res.success && res.data) setTokens(res.data);
  }, []);

  useEffect(() => {
    refresh()
      .catch(() => toast.error('读取连接列表失败'))
      .finally(() => setLoading(false));
    void getAgentTools()
      .then(setTools)
      .catch(() => setTools([]));
  }, [refresh]);

  const create = async () => {
    setBusy(true);
    try {
      const res = await createToken({ name: name.trim() || 'MCP 连接', scope });
      if (!res.success || !res.data) throw new Error(res.message || '创建失败');
      remember(res.data.id, res.data.token);
      setCreating(false);
      setName('');
      setFresh(res.data);
      await refresh();
    } catch (e) {
      toast.error(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t: ApiTokenInfo) => {
    if (!window.confirm(`断开「${t.name}」这个连接？agent 那边会立刻失效。`)) return;
    try {
      const res = await revokeToken(t.id);
      if (!res.success) throw new Error(res.message || '断开失败');
      forget(t.id);
      setViewing(null);
      await refresh();
      toast.success('连接已断开');
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const copy = async (text: string, what: string) => {
    if (await copyText(text)) toast.success(`${what}已复制`);
    else toast.error('复制失败，请手动选中复制');
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">接入 Codex</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            一个连接就是一把给 agent 的钥匙。建好之后点「复制连接方式」，粘到 agent
            的配置里即可；不想用了就断开。
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus />
          新建连接
        </Button>
      </div>

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : tokens.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Link2 className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              还没有连接。建一个，把连接方式复制给 Codex / Workbuddy 就能用。
            </p>
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
              新建连接
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {tokens.map((t) => {
            const plain = tokenOf(t);
            return (
              <div
                key={t.id}
                className="flex flex-col rounded-2xl border border-border/60 p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
                      <p className="truncate text-sm font-medium">{t.name}</p>
                      <Badge
                        variant={t.scope === 'write' ? 'default' : 'secondary'}
                        className="h-4 px-1 text-[10px]"
                      >
                        {t.scope === 'write' ? '可写' : '只读'}
                      </Badge>
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                      {t.prefix}…
                    </p>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label="更多"
                        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <MoreVertical className="size-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setViewing(t)}>
                        查看连接方式
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={!plain}
                        onClick={() => void copy(plain, '令牌')}
                      >
                        复制令牌
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => void remove(t)}
                      >
                        <Trash2 className="size-3.5" />
                        断开连接
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                <pre className="mt-3 flex-1 overflow-hidden rounded-lg bg-muted/40 p-2.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
                  {`[mcp_servers.zops]
url = "${mcpUrl}"
Authorization = "Bearer ${plain ? `${plain.slice(0, 12)}…` : '（本机没留底）'}"`}
                </pre>

                <div className="mt-3 flex items-center gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    disabled={!plain}
                    onClick={() => void copy(codexConfig(mcpUrl, plain), '连接方式')}
                  >
                    <Copy />
                    复制连接方式
                  </Button>
                  <span className="text-[11px] text-muted-foreground">
                    {t.last_used_at ? `用过 · ${t.last_used_at}` : '还没用过'}
                  </span>
                </div>
                {!plain && (
                  <p className="mt-2 text-[11px] text-amber-600">
                    这个连接是在改版前建的吗？令牌无法再取出来 —— 断开重建一个，就能随时复制了。
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        连上就能用：技能包（怎么用这些工具、部署剧本、排障剧本）挂在 MCP 的 `resources`
        上，agent 自己会读，不用另外装。
      </p>

      <div>
        <h2 className="mb-3 text-sm font-medium">这个连接能让 agent 帮你做什么</h2>
        <CapabilityGrid tools={tools} />
      </div>

      {/* 新建连接 */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建连接</DialogTitle>
            <DialogDescription>
              给它起个名字方便认（比如"Codex 桌面""Workbuddy"），选好权限。令牌只在
              创建后显示一次，同时会留底在这台浏览器上，方便以后点卡片复制。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="conn-name">名字</Label>
              <Input
                id="conn-name"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                placeholder="Codex 桌面"
              />
            </div>
            <div className="space-y-1.5">
              <Label>权限</Label>
              <div className="flex gap-2">
                {[
                  { id: 'read', label: '只读', desc: '只能看，不能改服务器' },
                  { id: 'write', label: '可写', desc: '能启停容器、部署、改网关' },
                ].map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setScope(s.id)}
                    className={cn(
                      'flex-1 rounded-xl border border-border/60 px-3 py-2 text-left transition-colors',
                      scope === s.id && 'border-primary/50 bg-primary/5',
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
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              取消
            </Button>
            <Button onClick={create} disabled={busy}>
              创建并复制
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 刚创建：令牌只显示这一次，让用户先把连接方式复制走 */}
      <Dialog open={!!fresh} onOpenChange={(v) => !v && setFresh(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>连接已创建</DialogTitle>
            <DialogDescription>
              把下面这段贴进 agent 的配置里就能用。以后随时点卡片上的「复制连接方式」
              也能再拿到。
            </DialogDescription>
          </DialogHeader>
          {fresh && <ConfigBlock url={mcpUrl} token={fresh.token} onCopy={copy} />}
          <DialogFooter>
            <Button onClick={() => setFresh(null)}>
              <Check />
              好了
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 查看某个连接的连接方式 */}
      <Dialog open={!!viewing} onOpenChange={(v) => !v && setViewing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{viewing?.name}</DialogTitle>
            <DialogDescription>
              {viewing && tokenOf(viewing)
                ? '这段配置直接贴给 agent 即可。'
                : '这台浏览器上没有这个连接的令牌留底（改版前建的吧），断开重建一个就能复制。'}
            </DialogDescription>
          </DialogHeader>
          {viewing && (
            <ConfigBlock
              url={mcpUrl}
              token={tokenOf(viewing)}
              onCopy={copy}
              placeholder="ops_在此粘贴你的令牌"
            />
          )}
          <DialogFooter>
            {viewing && (
              <Button variant="ghost" className="text-destructive" onClick={() => void remove(viewing)}>
                断开连接
              </Button>
            )}
            <Button onClick={() => setViewing(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function codexConfig(url: string, token: string): string {
  return `# ~/.codex/config.toml
[mcp_servers.zops]
url = "${url}"
http_headers = { Authorization = "Bearer ${token}" }`;
}

function jsonConfig(url: string, token: string): string {
  return `{
  "mcpServers": {
    "zops": {
      "url": "${url}",
      "headers": { "Authorization": "Bearer ${token}" }
    }
  }
}`;
}

/** 两种常见写法都摆出来，谁用什么复制什么。 */
function ConfigBlock({
  url,
  token,
  onCopy,
  placeholder,
}: {
  url: string;
  token: string;
  onCopy: (text: string, what: string) => Promise<void>;
  placeholder?: string;
}) {
  const value = token || placeholder || 'ops_在此粘贴你的令牌';
  const blocks = [
    { label: 'Codex（~/.codex/config.toml）', text: codexConfig(url, value) },
    { label: '通用 JSON（Claude / Workbuddy 等）', text: jsonConfig(url, value) },
  ];
  return (
    <div className="space-y-4">
      {blocks.map((b) => (
        <div key={b.label}>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-xs text-muted-foreground">{b.label}</p>
            <Button
              size="sm"
              variant="secondary"
              disabled={!token}
              onClick={() => void onCopy(b.text, '连接方式')}
            >
              <Copy />
              复制
            </Button>
          </div>
          <pre className="overflow-x-auto rounded-xl border border-border/60 bg-muted/30 p-3 font-mono text-xs leading-relaxed">
            {b.text}
          </pre>
        </div>
      ))}
    </div>
  );
}
