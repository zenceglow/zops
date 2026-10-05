import { get, post } from '../../lib/api';

export type Count = { key: string; count: number };
export type HourPoint = { hour: string; count: number };

/** 地球上的一个落点。count 只对访问点有意义（服务器自己那个是 0）。 */
export type GeoPoint = { label: string; lat: number; lon: number; count: number };

export type Security = {
  /** 被接入网关规则拦下的（403）。 */
  blocked: number;
  /** 自报是机器人的 UA。 */
  bots: number;
  /** 扫描器与脚本工具类 UA。 */
  tools: number;
  attackers: { ip: string; location: string; count: number }[];
  blocked_paths: Count[];
};

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
  self_location: GeoPoint | null;
  points: GeoPoint[];
  security: Security;
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
  /** 落点坐标；没查到归属地时是 0/0。 */
  lat: number;
  lon: number;
  /** 被网关拦下 / UA 不像浏览器。 */
  blocked: boolean;
  bot: boolean;
};

export type EventsPage = { events: AccessEvent[]; cursor: number };

/**
 * 服务器压力要的那几个数。
 *
 * 只列用得上的字段，不复用首页那份类型：两页的口径不一样（首页还管补丁和网络），
 * 跨页引一个"大而全"的类型，以后改动会互相绊住。
 */
export type SystemOverview = {
  cpu_usage: number;
  cpu_cores: number;
  memory_total: number;
  memory_used: number;
  memory_percent: number;
  swap_total: number;
  swap_used: number;
  disks: { mount: string; total: number; used: number; percent: number }[];
  load_avg: number[];
  processes: number;
  uptime_secs: number;
};

/** 要 `ops.system.read`；没有这个权限的账号会拿到 403。 */
export async function fetchSystemOverview() {
  return get<SystemOverview>('/system/overview');
}

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
