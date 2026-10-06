import { useTranslation } from 'react-i18next';
import {
  Activity,
  Clock,
  Container,
  FileText,
  Globe,
  Info,
  Puzzle,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '../../../components/ui/badge';
import { cn } from '../../../lib/utils';

export type AgentTool = { name: string; description: string; level: 'read' | 'write' };

/** 工具名 → 图标。按前缀归类比逐个列举好维护。 */
const ICON_RULES: [RegExp, LucideIcon][] = [
  [/^ops_panel_info/, Info],
  [/^ops_system_overview/, Activity],
  [/^ops_container/, Container],
  [/^ops_gateway|^ops_caddyfile/, Globe],
  [/^ops_log/, FileText],
  [/^ops_automation/, Clock],
  [/^ops_member/, Users],
];

function iconFor(name: string): LucideIcon {
  for (const [re, Icon] of ICON_RULES) {
    if (re.test(name)) return Icon;
  }
  return Puzzle;
}

/**
 * agent 装上技能包之后"能帮你做什么"。
 *
 * 之前这一栏直接把 SKILL.md 的 frontmatter 铺出来 —— 那是一段写给模型看的提示词，
 * 里面全是"当用户提到 ZOPS、MCP 里出现 ops_* 工具时使用"这种话术。用户看不懂，
 * 也不该看懂：这里要回答的是"它能帮我干什么"。
 *
 * 所以改成能力清单：一个图标一行，讲清楚做什么，并标出哪些动作会改服务器状态。
 */
export function CapabilityGrid({ tools }: { tools: AgentTool[] }) {
  const { t } = useTranslation();
  // 只读在前：用户先看到的是"它能看什么"，要动状态的排在后面并且带标记。
  const sorted = [...tools].sort((a, b) => (a.level === b.level ? 0 : a.level === 'read' ? -1 : 1));

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {sorted.map((tool) => {
        const Icon = iconFor(tool.name);
        const write = tool.level === 'write';
        // 描述来自服务端工具目录（中文）。英文界面下用 tools.<name> 覆盖；
        // 没覆盖到的（比如新加的工具）退回服务端那句 —— 宁可中文，也不要空着。
        const description = t(`tools.${tool.name}`, { defaultValue: tool.description });
        return (
          <div
            key={tool.name}
            className="flex items-start gap-3 rounded-xl border border-border/60 px-3.5 py-3"
            title={tool.name}
          >
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-lg',
                write ? 'bg-amber-500/12 text-amber-600 dark:text-amber-400' : 'bg-muted text-muted-foreground',
              )}
            >
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-snug">{description}</p>
              {write && (
                <Badge variant="secondary" className="mt-1.5 h-5 text-[10px]">
                  {t('mcp.write_badge')}
                </Badge>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
