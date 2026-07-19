import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useLogSources, useLogStream } from './_hooks/use-logs';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';

const COLORS = [
  'bg-blue-500/20 text-blue-400',
  'bg-green-500/20 text-green-400',
  'bg-yellow-500/20 text-yellow-400',
  'bg-purple-500/20 text-purple-400',
  'bg-pink-500/20 text-pink-400',
  'bg-cyan-500/20 text-cyan-400',
  'bg-orange-500/20 text-orange-400',
  'bg-teal-500/20 text-teal-400',
];

function getSourceColor(id: string, sources: string[]): string {
  const idx = sources.indexOf(id);
  return COLORS[idx % COLORS.length];
}

function highlightMatches(text: string, query: string): React.ReactNode {
  if (!query) return text;
  try {
    const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
    return parts.map((part, i) =>
      part.toLowerCase() === query.toLowerCase()
        ? <mark key={i} className="rounded bg-yellow-400/30 text-yellow-200 px-0.5">{part}</mark>
        : part,
    );
  } catch {
    return text;
  }
}

export default function LogsPage() {
  const { t } = useTranslation();
  const {
    sources,
    selectedIds,
    loading,
    handleAdd,
    handleRemove,
    toggleSource,
  } = useLogSources();

  const { lines, connected, paused, handlePauseToggle, clearLines, sourceLabelMap } =
    useLogStream(selectedIds, sources);

  const [search, setSearch] = useState('');
  const [filterSource, setFilterSource] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [newLabel, setNewLabel] = useState('');

  const filteredLines = useMemo(() => {
    let result = lines;
    if (filterSource) {
      result = result.filter((l) => l.sourceId === filterSource);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((l) => l.line.toLowerCase().includes(q));
    }
    return result;
  }, [lines, filterSource, search]);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [filteredLines, autoScroll]);

  const sourceIds = useMemo(() => [...new Set(lines.map((l) => l.sourceId))], [lines]);

  const handleAddSource = useCallback(async () => {
    if (!newPath.trim()) return;
    await handleAdd(newPath.trim(), newLabel.trim() || newPath.trim());
    setNewPath('');
    setNewLabel('');
    setAdding(false);
  }, [newPath, newLabel, handleAdd]);

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">{t('logs.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('logs.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-xs text-muted-foreground">
            {connected ? t('ssh.status_connected') : t('ssh.status_closed')}
          </span>
        </div>
      </div>

      {/* Source Management */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-muted-foreground">{t('logs.add_source')}:</span>
        {sources.map((s) => (
          <Badge
            key={s.id}
            variant={selectedIds.has(s.id) ? 'default' : 'secondary'}
            className="cursor-pointer gap-1"
            onClick={() => toggleSource(s.id)}
          >
            <span className={`inline-flex h-1.5 w-1.5 rounded-full ${selectedIds.has(s.id) ? 'bg-green-400' : 'bg-muted-foreground'}`} />
            {s.label || s.path}
            <button
              onClick={(e) => { e.stopPropagation(); handleRemove(s.id); }}
              className="ml-1 rounded-full hover:bg-destructive/20 hover:text-destructive px-0.5 text-xs"
            >
              &#x2715;
            </button>
          </Badge>
        ))}
        {adding ? (
          <div className="flex items-center gap-1">
            <Input
              className="h-7 w-32 text-xs"
              placeholder={t('logs.source_label_placeholder')}
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddSource()}
            />
            <Input
              className="h-7 w-48 text-xs"
              placeholder={t('logs.source_path_placeholder')}
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddSource()}
              autoFocus
            />
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={handleAddSource}>{t('logs.add')}</Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAdding(false)}>{t('automation.cancel')}</Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAdding(true)} disabled={loading}>
            + {t('logs.add_source')}
          </Button>
        )}
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <Input
          className="h-8 w-64 text-xs"
          placeholder={t('logs.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSearch('')}>
            {t('logs.clear')}
          </Button>
        )}
        <div className="h-6 w-px bg-border" />
        <select
          className="h-7 rounded-md border border-input bg-background px-2 text-xs"
          value={filterSource || ''}
          onChange={(e) => setFilterSource(e.target.value || null)}
        >
          <option value="">{t('logs.filter')}: {t('nav.overview')}</option>
          {sourceIds.map((id) => (
            <option key={id} value={id}>{sourceLabelMap.get(id) || id}</option>
          ))}
        </select>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={() => setAutoScroll(!autoScroll)}
        >
          {autoScroll ? `${t('logs.auto_scroll')}: ON` : `${t('logs.auto_scroll')}: OFF`}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={handlePauseToggle}
        >
          {paused ? t('logs.resume') : t('logs.paused')}
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={clearLines}>
          {t('logs.clear')}
        </Button>
        <span className="text-xs text-muted-foreground">{filteredLines.length} {t('logs.lines')}</span>
      </div>

      {/* Log output */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto rounded-lg border bg-black/50 p-3 font-mono text-xs leading-relaxed"
      >
        {filteredLines.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            {loading ? t('app.loading') : t('logs.no_sources')}
          </div>
        ) : (
          filteredLines.map((line, i) => (
            <div key={`${line.timestamp}-${i}`} className="flex gap-2 hover:bg-white/5">
              <span className={`shrink-0 rounded px-1 text-[10px] leading-5 ${getSourceColor(line.sourceId, sourceIds)}`}>
                {sourceLabelMap.get(line.sourceId) || line.sourceId}
              </span>
              <span className="whitespace-pre-wrap break-all">{highlightMatches(line.line, search)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
