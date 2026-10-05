import { get, post } from '../../lib/api';

export type Count = { key: string; count: number };
export type HourPoint = { hour: string; count: number };

export type AnalyticsOverview = {
  hours: number;
  total: number;
  unique_ips: number;
  per_minute: number;
  locations: Count[];
  hosts: Count[];
  paths: Count[];
  statuses: Count[];
  hourly: HourPoint[];
  /** 最新一条记录的 id，作为增量拉取的游标。 */
  cursor: number;
  /** 正在采集的访问日志文件。全是空的时候要能解释"为什么一条都没有"。 */
  sources: string[];
  geo: { enabled: boolean; endpoint: string; note: string };
};

export type AccessEvent = {
  id: number;
  ts: number;
  /** 服务端换算好的本地时间 HH:MM:SS。 */
  time: string;
  ip: string;
  location: string;
  isp: string;
  host: string;
  method: string;
  uri: string;
  status: number;
  bytes: number;
  ua: string;
};

export type EventsPage = { events: AccessEvent[]; cursor: number };

export async function fetchOverview(hours: number) {
  const res = await get<AnalyticsOverview>(`/analytics/overview?hours=${hours}`);
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

/** `after = 0` 表示"给我最近的一批"；之后只取比游标更新的。 */
export async function fetchEvents(after: number, limit = 40) {
  const res = await get<EventsPage>(`/analytics/events?after=${after}&limit=${limit}`);
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

/** 立刻采一轮，不用等后台那 15 秒。 */
export async function refreshNow() {
  const res = await post('/analytics/refresh');
  if (!res.success) throw new Error(res.message || 'Failed');
}
