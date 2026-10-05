import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { copyText } from '../../lib/clipboard';
import { CapabilityGrid, type AgentTool } from './_components/capability-grid';
import {
  createToken,
  getAgentTools,
  getSkill,
  listTokens,
  revokeToken,
  type ApiTokenCreated,
  type ApiTokenInfo,
} from './_api';

function CopyBlock({ label, value }: { label?: string; value: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    // 走统一的复制实现：公网 http 下 navigator.clipboard 不存在，直接用它等于
    // 点了没反应。失败时明确说"手动选中复制"，别让用户以为已经复制走了。
    if (await copyText(value)) {
      setDone(true);
      setTimeout(() => setDone(false), 1600);
    } else {
      toast.error('复制失败，请手动选中这段文本复制');
    }
  };
  return (
    <div className="relative">
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
 * 这一页只回答三件事：用哪个令牌、把哪段配置粘给 agent、agent 装上之后能帮你做
 * 什么。最后那条用**图标清单**呈现 —— SKILL.md 是写给模型看的提示词，用户看不懂
 * 也不该看懂；用户要的是"它能帮我干什么、哪些动作会动我的服务器"。
 */
export default function McpPage() {
  const { t } = useTranslation();
  const [tokens, setTokens] = useState<ApiTokenInfo[]>([]);
  const [tools, setTools] = useState<AgentTool[]>([]);
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
    // 能力清单来自后端工具目录：跟 agent 实际拿到的工具是同一份，不会各说各话。
    void getAgentTools()
      .then(setTools)
      .catch(() => setTools([]));
  }, [refresh]);

  const origin = window.location.origin;
  const mcpUrl = `${origin}/api/ops/mcp`;
  const token = created?.token ?? 'ops_在此粘贴你的令牌';

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

  // 先下到临时文件、成功再挪过去。直接 `curl ... > 目标文件` 的话，令牌写错时
  // shell 已经把目标文件清空了，curl 再失败 —— 结果是 agent 读到一个空的 SKILL.md，
  // 比没装还难查。
  const skillCmd = `D=~/.agents/skills/zops
mkdir -p "$D/references"
curl -fsSL -H "Authorization: Bearer ${token}" \\
  ${origin}/api/ops/skill/raw -o "$D/SKILL.md.new" && mv "$D/SKILL.md.new" "$D/SKILL.md"
curl -fsSL -H "Authorization: Bearer ${token}" \\
  ${origin}/api/ops/skill/references/troubleshooting \\
  -o "$D/references/troubleshooting.md.new" \\
  && mv "$D/references/troubleshooting.md.new" "$D/references/troubleshooting.md"
curl -fsSL -H "Authorization: Bearer ${token}" \\
  ${origin}/api/ops/skill/references/deploy \\
  -o "$D/references/deploy.md.new" \\
  && mv "$D/references/deploy.md.new" "$D/references/deploy.md"
echo "已装到 $D"`;

  const create = async () => {
    setBusy(true);
    try {
      const res = await createToken({ name: 'MCP agent', scope });
      if (!res.success || !res.data) {
        toast.error(res.message || '创建失败');
        return;
      }
      setCreated(res.data);
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
          {!created && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              上面那段里还是占位令牌，直接粘给 agent 会连不上 —— 先点「新建令牌」，
              配置会自动带上它。
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            新建令牌后这段会自动带上它；刷新页面就拿不到令牌原文了，那时得重新建一个。
            走公网 IP 的 http 是明文传输，长期用建议配域名走 HTTPS。
          </p>
        </CardContent>
      </Card>

      {/* 3. 能力清单 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Puzzle className="size-4" />
            {t('mcp.skill')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('mcp.skill_intro', { count: tools.length })}
          </p>
          {tools.length > 0 && <CapabilityGrid tools={tools} />}
          <CopyBlock label={t('mcp.install_label')} value={skillCmd} />
          <button
            type="button"
            onClick={() => setShowSkill((v) => !v)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown className={cn('size-3.5 transition-transform', showSkill && 'rotate-180')} />
            {showSkill ? t('mcp.hide_source') : t('mcp.show_source')}
          </button>
          {showSkill && <CopyBlock value={skill || '（加载中…）'} />}
        </CardContent>
      </Card>
    </div>
  );
}
