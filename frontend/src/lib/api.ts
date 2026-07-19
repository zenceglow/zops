import useAuthorizeStore from '../stores/authorize.store';
import useUserStore from '../stores/user.store';
import type { ApiResultType } from './types/api-response';

const BASE = '/api/ops';

function clearSessionAndRedirect() {
  useAuthorizeStore.getState().logout();
  useUserStore.getState().clear();
  window.location.href = '/login';
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | number | undefined>,
): Promise<ApiResultType<T>> {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {};
  const token = useAuthorizeStore.getState().token;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url.pathname + url.search, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let payload: ApiResultType<T> | null = null;
  try {
    payload = (await res.json()) as ApiResultType<T>;
  } catch {
    /* empty */
  }

  if (res.status === 401 || payload?.code === 401) {
    // Login / setup 的 401 是业务失败，交给页面展示，不要清会话跳转
    const isPublicAuth =
      path === '/auth/login' || path.startsWith('/setup/');
    if (!isPublicAuth) {
      clearSessionAndRedirect();
      throw new Error(payload?.message || 'Unauthorized');
    }
  }

  if (!payload) {
    return {
      success: false,
      code: res.status || 0,
      message: res.status === 401 ? '用户名或密码错误' : 'Invalid response',
    };
  }

  return payload;
}

export function get<T>(path: string, query?: Record<string, string | number | undefined>) {
  return request<T>('GET', path, undefined, query);
}

export function post<T>(path: string, body?: unknown) {
  return request<T>('POST', path, body);
}

export function put<T>(path: string, body?: unknown) {
  return request<T>('PUT', path, body);
}

export function del<T>(path: string, query?: Record<string, string | number | undefined>) {
  return request<T>('DELETE', path, undefined, query);
}

export type { ApiResultType } from './types/api-response';
