import { get } from '../../lib/api';
import type { AccessEvent, AnalyticsOverview, EventsPage } from '../screen/_api';
import type { SecurityEvent } from '../security/_api';

export type { AccessEvent, AnalyticsOverview, EventsPage, SecurityEvent };

/** 访问总览：总量、独立 IP、主机/路径/状态分布、落点、安全计数都在这一份里。 */
export async function fetchAnalytics(hours: number) {
  const res = await get<AnalyticsOverview>(`/analytics/overview?hours=${hours}`);
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

/**
 * 最近 N 条访问记录。
 *
 * `/analytics/events` 是**游标式**的（返回 id > after_id 的行，升序），所以取"最后
 * N 条"的做法是从总览给的最后一条 id 往前退 N —— 而不是传 0（那会给你这台机器
 * 最早的那批记录，看着像"数据不对"）。
 */
export async function fetchRecentAccess(cursor: number, limit = 200) {
  const after = Math.max(0, cursor - limit);
  const res = await get<EventsPage>(`/analytics/events?after_id=${after}&limit=${limit}`);
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data.events.slice().reverse();
}

/** 攻击 / 机器人 / 探测都在这一份里（按 kind 分），一次拉回来前端分 tab。 */
export async function fetchSecurityEvents(limit = 200) {
  const res = await get<SecurityEvent[]>('/security/events', { limit });
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}
