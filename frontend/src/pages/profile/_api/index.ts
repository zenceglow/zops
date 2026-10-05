import { get } from '../../../lib/api';

export type Me = {
  id: number;
  username: string;
  role: string;
  permissions: string[];
  created_at: string;
};

export type AuditRow = {
  id: number;
  at: string;
  actor: string;
  /** user | agent */
  actor_kind: string;
  ip: string;
  method: string;
  path: string;
  status: number;
  summary: string;
  detail: string;
  duration_ms: number;
};

export async function fetchMe() {
  const res = await get<Me>('/auth/me');
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

/** 我自己干过什么。这个接口不需要 audit.read —— 看自己的记录不用额外授权。 */
export async function fetchMyAudit(limit = 100) {
  const res = await get<AuditRow[]>(`/audit/me?limit=${limit}`);
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}
