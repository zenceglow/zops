import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, Copy, KeyRound, Plus, Puzzle, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { toast } from '../../components/ui/sonner';
import { cn } from '../../lib/utils';
import {
  createToken,
  getSkill,
  listTokens,
  revokeToken,
  type ApiTokenCreated,
  type ApiTokenInfo,
} from './_api';

/** 从 SKILL.md 的 frontmatter 里取名字和描述，正文不用整篇铺出来。 */
function skillSummary(content: string) {
  const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const pick = (k: string) => fm.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? '';
  return { name: pick('name'), description: pick('description') };
}

function CopyBlock({
  label,
  value,
  className,
}: {
  label?: string;
  value: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1600);
    } catch {
      toast.error('复制失败，请手动选择');
    }
  };
  return (
    <div className={cn('relative', className)}>
      {label && <p className="mb-1.5 text-xs text-muted-foreground">{label}</p>}
      <pre className="overflow-x-auto rounded-xl border border-border/60 bg-muted/30 p-3 pr-20 font-mono text-xs leading-relaxed">
        {value}
      </pre>
      <Button variant="secondary" size="sm" className="absolute right-2 bottom-2" onClick={copy}>
        {done ? <Check /> : <Copy />}
        {done ? '已复制' : '复制'}
      </Button>
    </div>
  );
}

/**
 * MCP 接入。
 *
 * 这一页只回答三件事：用哪个令牌、把哪段配置粘给 agent、有什么技能可用。
 * 之前那版把令牌表单、三种命令行、SKILL.md 全文都摊在一屏上 —— 那是在演示
 * "我们支持多少种用法"，而不是让用户两分钟接完。技能正文收进折叠里，要看再看。
 */
export default function McpPage() {
  const [tokens, setTokens] = useState<ApiTokenInfo[]>([]);
  const [skill, setSkill] = useState('');
  const [scope, setScope] = useState('read');
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const [flavor, setFlavor] = useState<'codex' | 'json'>('codex');
  const [busy, setBusy] = useState(false);
  const [showSkill, setShowSkill] = useState(false);

  const refresh = useCallback(async () => {
    const res = await listTokens();
    if (res.success && res.data) setTokens(res.data);
  }, []);

  useEffect(() => {
    void refresh();
    void getSkill().then((r) => setSkill(r.content));
  }, [refresh]);

  const origin = window.location.origin;
  const mcpUrl = `${origin}/api/ops/mcp`;
  const token = created?.token ?? 'ops_在此粘贴你的令牌';
  const [showToken, setShowToken] = useState(false);

  const config = {
    codex: `# ~/.codex/config.toml
[mcp_servers.zops]
url = "${mcpUrl}"
http_headers = { Authorization = "Bearer ${token}" }`,
    json: `{
  "mcpServers": {
    "zops": {
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer ${token}" }
    }
  }
}`,
  }[flavor];

  const skillCmd = `mkdir -p ~/.agents/skills/zops/references
curl -fsSL -H "Authorization: Bearer ${token}" \\
  ${origin}/api/ops/skill/raw > ~/.agents/skills/zops/SKILL.md
curl -fsSL -H "Authorization: Bearer ${token}" \\
  ${origin}/api/ops/skill/references/troubleshooting > ~/.agents/skills/zops/references/troubleshooting.md`;

  const create = async () => {
    setBusy(true);
    try {
      const res = await createToken({ name: 'MCP agent', scope });
      if (!res.success || !res.data) {
        toast.error(res.message || '创建失败');
        return;
      }
      setCreated(res.data);
      setShowToken(true);
      await refresh();
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

  const summary = skillSummary(skill);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">MCP</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          把这个面板作为 MCP 服务器接进 Codex、Workbuddy 等支持标准 MCP 的 agent，
          它就能帮你运维这台服务器。
        </p>
      </div>

      {/* 1. 令牌 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4" />
            访问令牌
          </CardTitle>
          <div className="flex items-center gap-2">
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger className="h-8 w-[104px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="read">只读</SelectItem>
                <SelectItem value="write">可写</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" onClick={create} disabled={busy}>
              <Plus />
              新建令牌
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {created && (
            <div className="space-y-2 rounded-xl border border-primary/40 bg-primary/5 p-3">
              <p className="text-sm font-medium">令牌只显示这一次，复制走再关掉</p>
              <CopyBlock value={created.token} />
            </div>
          )}

          {tokens.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {tokens.map((tk) => (
                <span
                  key={tk.id}
                  className="inline-flex items-center gap-2 rounded-xl border border-border/60 py-1 pr-1 pl-2.5 text-xs"
                >
                  <Badge variant={tk.scope === 'write' ? 'default' : 'secondary'} className="h-5">
                    {tk.scope === 'write' ? '可写' : '只读'}
                  </Badge>
                  <span className="font-mono text-muted-foreground">{tk.prefix}…</span>
                  <button
                    type="button"
                    onClick={() => void revoke(tk.id, tk.name)}
                    className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                    aria-label={`删除 ${tk.name}`}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {!created && tokens.length === 0 && (
            <p className="text-sm text-muted-foreground">
              还没有令牌 —— 先点「新建令牌」，下面的配置会自动带上它。
            </p>
          )}
        </CardContent>
      </Card>

      {/* 2. 配置 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">复制给 Agent</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="inline-flex rounded-xl bg-muted/60 p-0.5">
            {(['codex', 'json'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFlavor(f)}
                className={cn(
                  'rounded-lg px-3 py-1 text-xs transition-colors',
                  flavor === f ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground',
                )}
              >
                {f === 'codex' ? 'Codex' : '通用 JSON'}
              </button>
            ))}
          </div>
          <CopyBlock
            label={flavor === 'codex' ? '~/.codex/config.toml' : 'Workbuddy / Cursor / Claude Desktop 等'}
            value={config}
          />
          <p className="text-xs text-muted-foreground">
            令牌没填的话，先把上面新建的令牌复制进来；走公网 IP 的 http 是明文传输，长期用建议配域名走 HTTPS。
          </p>
        </CardContent>
      </Card>

      {/* 3. 技能 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Puzzle className="size-4" />
            技能
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-xl border border-border/60 px-4 py-3">
            <p className="font-mono text-sm font-medium">{summary.name || 'zops'}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {summary.description || '（加载中…）'}
            </p>
          </div>
          <CopyBlock label="装到 agent 的技能目录" value={skillCmd} />
          <button
            type="button"
            onClick={() => setShowSkill((v) => !v)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown className={cn('size-3.5 transition-transform', showSkill && 'rotate-180')} />
            {showSkill ? '收起技能原文' : '查看技能原文'}
          </button>
          {showSkill && <CopyBlock value={skill || '（加载中…）'} />}
        </CardContent>
      </Card>
    </div>
  );
}
