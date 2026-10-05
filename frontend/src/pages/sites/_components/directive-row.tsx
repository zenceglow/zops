import { useTranslation } from 'react-i18next';
import {
  Filter,
  Server,
  ShieldCheck,
  ExternalLink,
  FolderOpen,
  ArrowRight,
  Send,
  FileCode,
  FolderTree,
  FileText,
} from 'lucide-react';
import type { Directive } from '../_api';

/** 指令 → 图标 + i18n 后缀（`sites.directive.<x>`）。 */
const DIRECTIVE_META: Record<
  string,
  { icon: React.ComponentType<{ className?: string }>; labelKey: string }
> = {
  reverse_proxy: { icon: ExternalLink, labelKey: 'reverse_proxy' },
  root: { icon: FolderOpen, labelKey: 'root' },
  file_server: { icon: FileText, labelKey: 'file_server' },
  redir: { icon: ArrowRight, labelKey: 'redir' },
  respond: { icon: Send, labelKey: 'respond' },
  encode: { icon: FileCode, labelKey: 'encode' },
  handle_path: { icon: FolderTree, labelKey: 'handle_path' },
  handle: { icon: FolderTree, labelKey: 'handle' },
  route: { icon: FolderTree, labelKey: 'route' },
  header: { icon: FileCode, labelKey: 'header' },
  header_up: { icon: Send, labelKey: 'header_up' },
  log: { icon: FileText, labelKey: 'log' },
  tls: { icon: ShieldCheck, labelKey: 'tls' },
};

export function DirectiveRow({ directive }: { directive: Directive }) {
  const { t } = useTranslation();
  // 命名匹配器（@apiPaths { ... }）不是指令，是给 handle / respond 用的条件。
  // 混在指令列表里用同一个图标，会让人以为多了个叫 "@apiPaths" 的服务。
  const isMatcher = directive.key.startsWith('@');
  // `-Server`、`-X-Powered-By` 是"删掉某个响应头"，不是名字以减号开头的指令。
  const isHeaderRemoval = directive.key.startsWith('-');
  const meta = isMatcher ? { icon: Filter, labelKey: 'matcher' } : DIRECTIVE_META[directive.key];
  const Icon = meta?.icon || Server;
  // 有名字就给名字，没有就只留指令本身 —— 之前拿 key 当兜底标签，于是每行都把
  // 指令名打了两遍（"header header"、"-Server -Server"）。
  const label = isHeaderRemoval
    ? t('sites.directive.header_remove')
    : meta
      ? t(`sites.directive.${meta.labelKey}`)
      : null;

  return (
    <div className="px-4 py-2.5 hover:bg-muted/30 transition-colors">
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs text-muted-foreground font-mono">{directive.key}</span>
        {label && <span className="text-sm font-medium">{label}</span>}
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
