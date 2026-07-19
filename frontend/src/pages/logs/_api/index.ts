import { del, get, post } from '../../../lib/api';
import type { ApiResultType } from '../../../lib/types/api-response';

export interface LogSource {
  id: string;
  path: string;
  label: string;
}

export function listLogSources(): Promise<ApiResultType<LogSource[]>> {
  return get<LogSource[]>('/log/sources');
}

export function addLogSource(
  path: string,
  label: string,
): Promise<ApiResultType<LogSource>> {
  return post<LogSource>('/log/sources', { path, label });
}

export function removeLogSource(id: string): Promise<ApiResultType<null>> {
  return del<null>('/log/sources', { id });
}

export function logStreamUrl(sourceIds: string[]): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = (() => {
    try {
      const s = localStorage.getItem('zenceglow-auth-store');
      if (!s) return '';
      const parsed = JSON.parse(s);
      return parsed?.state?.token || '';
    } catch {
      return '';
    }
  })();
  const ids = sourceIds.join(',');
  return `${protocol}//${location.host}/api/ops/log/stream?ids=${encodeURIComponent(ids)}&token=${encodeURIComponent(token)}`;
}
