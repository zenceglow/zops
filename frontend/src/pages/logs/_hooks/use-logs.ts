import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listLogSources,
  addLogSource,
  removeLogSource,
  logStreamUrl,
  type LogSource,
} from '../_api';
import { toast } from 'sonner';

interface LogLine {
  sourceId: string;
  sourceLabel: string;
  line: string;
  timestamp: number;
}

export function useLogSources() {
  const [sources, setSources] = useState<LogSource[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const fetchSources = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listLogSources();
      if (res.success && res.data) {
        setSources(res.data);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (const s of res.data!) next.add(s.id);
          return next;
        });
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSources();
  }, [fetchSources]);

  const handleAdd = useCallback(
    async (path: string, label: string) => {
      const res = await addLogSource(path, label);
      if (res.success && res.data) {
        setSources((prev) => [...prev, res.data!]);
        setSelectedIds((prev) => new Set(prev).add(res.data!.id));
        toast.success('日志源已添加');
      } else {
        toast.error(res.message || '添加失败');
      }
    },
    [],
  );

  const handleRemove = useCallback(async (id: string) => {
    const res = await removeLogSource(id);
    if (res.success) {
      setSources((prev) => prev.filter((s) => s.id !== id));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      toast.success('已移除');
    } else {
      toast.error(res.message || '移除失败');
    }
  }, []);

  const toggleSource = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return {
    sources,
    selectedIds,
    loading,
    handleAdd,
    handleRemove,
    toggleSource,
  };
}

const MAX_LINES = 10_000;

export function useLogStream(selectedIds: Set<string>, sources: LogSource[]) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pausedBuffer = useRef<LogLine[]>([]);

  useEffect(() => {
    if (selectedIds.size === 0) {
      wsRef.current?.close();
      return;
    }

    const url = logStreamUrl([...selectedIds]);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);

    ws.onmessage = (event) => {
      try {
        const parsed: LogLine = JSON.parse(event.data);
        const newLine = { ...parsed, timestamp: Date.now() };

        if (paused) {
          pausedBuffer.current.push(newLine);
          return;
        }

        setLines((prev) => {
          const next = [...prev, newLine];
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
      } catch {
        /* ignore */
      }
    };

    return () => {
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds]);

  const handlePauseToggle = useCallback(() => {
    setPaused((prev) => {
      if (prev) {
        // resume: flush buffer
        setLines((ls) => {
          const buf = pausedBuffer.current;
          pausedBuffer.current = [];
          const next = [...ls, ...buf];
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
      }
      return !prev;
    });
  }, []);

  const clearLines = useCallback(() => {
    setLines([]);
    pausedBuffer.current = [];
  }, []);

  return { lines, connected, paused, handlePauseToggle, clearLines, sourceLabelMap: new Map(sources.map((s) => [s.id, s.label])) };
}
