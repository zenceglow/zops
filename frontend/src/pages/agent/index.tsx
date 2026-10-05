import { useCallback, useEffect, useState } from 'react';
import { Bot, Copy, KeyRound, Plus, RefreshCw, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { toast } from '../../components/ui/sonner';
import {
  createToken,
  getSkill,
  listTokens,
  revokeToken,
  type ApiTokenCreated,
  type ApiTokenInfo,
} from './_api';

function CopyRow({ label, value, mono = true }: { label?: string; value: string; mono?: boolean }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('已复制');
    } catch {
      toast.error('复制失败，请手动选择');
    }
  };
  return (
    <div className="space-y-1.5">
      {label && <p className="text-xs text-muted-foreground">{label}</p>}
      <div className="flex items-start gap-2">
        <pre
          className={`min-w-0 flex-1 overflow-x-auto rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed ${
            mono ? 'font-mono' : ''
          }`}
        >
          {value}
        </pre>
        <Button variant="secondary" size="sm" onClick={copy} className="shrink-0">
          <Copy />
          复制
        </Button>
      </div>
    </div>
  );
}

export default function AgentPage() {
  const [tokens, setTokens] = useState<ApiTokenInfo[]>([]);
  const [skill, setSkill] = useState<string>('');
  const [name, setName] = useState('');
  const [scope, setScope] = useState('read');
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const res = await listTokens();
    if (res.success && res.data) setTokens(res.data);
    else toast.error(res.message || '加载令牌失败');
  }, []);

  useEffect(() => {
    void refresh();
    void getSkill().then((r) => {
      if (r.success && r.data) setSkill(r.data.content);
    });
  }, [refresh]);

  const origin = window.location.origin;
  // MCP 走独立路径（自带 Bearer 校验），不是面板的 /api/ops 组。
  const mcpUrl = `${origin}/api/ops/mcp`;
  const skillUrl = `${origin}/api/ops/skill/raw`;
  const refUrl = `${origin}/api/ops/skill/references/troubleshooting`;

  const tokenForSnippet = created?.token ?? 'ops_在此粘贴你的令牌';

  const cliSnippet = `# 1) 把令牌放进环境变量（写进 ~/.zshrc 或 ~/.bashrc 可长期生效）
export OPS_TOKEN="${tokenForSnippet}"

# 2) 注册 MCP 服务器
codex mcp add zops --url ${mcpUrl} --bearer-token-env-var OPS_TOKEN`;

  const tomlSnippet = `# ~/.codex/config.toml
[mcp_servers.zops]
url = "${mcpUrl}"
# 从环境变量取令牌（推荐，不把密钥写进配置文件）
bearer_token_env_var = "OPS_TOKEN"

# 不想用环境变量？改成静态请求头即可：
# http_headers = { Authorization = "Bearer ${tokenForSnippet}" }`;

  const skillSnippet = `mkdir -p ~/.agents/skills/zops/references
curl -fsSL -H "Authorization: Bearer ${tokenForSnippet}" \\
  ${skillUrl} > ~/.agents/skills/zops/SKILL.md
curl -fsSL -H "Authorization: Bearer ${tokenForSnippet}" \\
  ${refUrl} > ~/.agents/skills/zops/references/troubleshooting.md`;

  const create = async () => {
    setBusy(true);
    try {
      const res = await createToken({ name: name.trim() || 'Codex', scope });
      if (!res.success || !res.data) {
        toast.error(res.message || '创建失败');
        return;
      }
      setCreated(res.data);
      setName('');
      await refresh();
      toast.success('令牌已创建，请立即复制');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string, label: string) => {
    const res = await revokeToken(id);
    if (!res.success) {
      toast.error(res.message || '删除失败');
      return;
    }
    if (created?.id === id) setCreated(null);
    toast.success(`已删除 ${label}`);
    await refresh();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">接入 Codex</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          把本面板作为 MCP 服务器接进 Codex，让 Codex 用这些工具帮你运维这台服务器。
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="size-4" />
            MCP 地址
          </CardTitle>
          <CardDescription>
            Codex 通过这个地址访问。默认安装不需要域名，直接用 IP:端口即可。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <CopyRow value={mcpUrl} />
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary">JSON-RPC over HTTP</Badge>
            <Badge variant="secondary">鉴权：Authorization: Bearer ops_…</Badge>
            <Badge variant="secondary">只支持 POST（未开 SSE）</Badge>
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              走公网 IP 的 http 是明文传输，令牌会被同链路上的设备看到。长期使用建议在面板里挂个域名
              （Caddy 反代 + HTTPS），或只在内网/跳板机上使用。
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4" />
            访问令牌
          </CardTitle>
          <CardDescription>
            令牌明文只在创建时显示一次，服务端只存哈希。只读令牌能看负载/日志/容器，但不能改任何东西。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[180px] flex-1 space-y-1.5">
              <Label htmlFor="token-name">名称</Label>
              <Input
                id="token-name"
                placeholder="例如：我的 Codex"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="w-[150px] space-y-1.5">
              <Label>权限</Label>
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="read">只读</SelectItem>
                  <SelectItem value="write">可写</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={create} disabled={busy}>
              <Plus />
              创建
            </Button>
            <Button variant="secondary" onClick={() => void refresh()}>
              <RefreshCw />
              刷新
            </Button>
          </div>

          {created && (
            <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <ShieldCheck className="size-4 text-primary" />
                令牌已创建 —— 现在复制，关掉就看不到了
              </p>
              <CopyRow value={created.token} />
            </div>
          )}

          <div className="divide-y rounded-lg border">
            {tokens.length === 0 && (
              <p className="p-4 text-center text-sm text-muted-foreground">还没有令牌</p>
            )}
            {tokens.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{t.name}</span>
                    <Badge variant={t.scope === 'write' ? 'default' : 'secondary'}>
                      {t.scope === 'write' ? '可写' : '只读'}
                    </Badge>
                  </div>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                    {t.prefix}…{t.last_used_at ? ` · 最近使用 ${t.last_used_at}` : ' · 尚未使用'}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => void revoke(t.id, t.name)}>
                  <Trash2 />
                  删除
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">复制给 Codex</CardTitle>
          <CardDescription>
            先创建令牌，再挑一种方式粘贴。下面已经带上当前面板地址和令牌。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <CopyRow label="方式一：命令行注册（推荐）" value={cliSnippet} />
          <CopyRow label="方式二：写进 config.toml" value={tomlSnippet} />
          <CopyRow label="顺便装上技能包（让 Codex 会用它）" value={skillSnippet} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">技能内容</CardTitle>
          <CardDescription>
            这是随二进制分发的 SKILL.md。装到 ~/.agents/skills/zops/ 后，Codex 会在
            「服务器出问题」时自动用上。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CopyRow value={skill || '（加载中…）'} />
        </CardContent>
      </Card>
    </div>
  );
}
