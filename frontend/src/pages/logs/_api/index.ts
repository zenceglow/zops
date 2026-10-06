import { del, get, post } from '../../../lib/api';
import type { ApiResultType } from '../../../lib/types/api-response';
import useAuthorizeStore from '../../../stores/authorize.store';

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

/** id 是路径参数：`DELETE /log/sources/{id}`（后端就是这么挂的路由）。 */
export function removeLogSource(id: string): Promise<ApiResultType<null>> {
  return del<null>(`/log/sources/${encodeURIComponent(id)}`);
}

/** 先看末尾 200 行，再接上实时流 —— 就是 `tail -n 200 -f <path>` 的界面版。 */
export function tailLog(path: string, tail = 200): Promise<ApiResultType<LogTail>> {
  return get<LogTail>('/log/tail', { path, tail });
}

export interface LogTail {
  path: string;
  lines: string[];
  truncated: boolean;
}

/** 卡片上展示的那条命令，和用户平时手敲的一模一样。 */
export function tailCommand(path: string, tail = 200): string {
  return `tail -n ${tail} -f ${path}`;
}

export function logStreamUrl(sourceIds: string[]): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // 令牌存在 zustand store 里，而且那份持久化是**加密**的 —— 以前这里去
  // localStorage 里翻明文 key，既找错了名字也拿不到解密后的值，WebSocket 一路 401，
  // 实时日志从来没连上过。要取就从 store 取。
  const token = useAuthorizeStore.getState().token ?? '';
  const ids = sourceIds.join(',');
  return `${protocol}//${location.host}/api/ops/log/stream?ids=${encodeURIComponent(ids)}&token=${encodeURIComponent(token)}`;
}
