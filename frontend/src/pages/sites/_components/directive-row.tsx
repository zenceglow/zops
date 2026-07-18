import {
  Server,
  ExternalLink,
  FolderOpen,
  ArrowRight,
  Send,
  FileCode,
  FolderTree,
  FileText,
} from 'lucide-react';
import type { Directive } from '../_api';

export function DirectiveRow({ directive }: { directive: Directive }) {
  const iconMap: Record<
    string,
    { icon: React.ComponentType<{ className?: string }>; label: string }
  > = {
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
