import { get, post } from '../../../lib/api';
import type { ApiResultType } from '../../../lib/types/api-response';
import i18n from '../../../i18n/i18n';

export type ExposedPort = {
  port: number;
  address: string;
  process: string;
  container?: string | null;
  public: boolean;
};

export type Firewall = {
  tool: string;
  active: boolean;
  summary: string;
  rules: string[];
  exposed: ExposedPort[];
};

export type SecurityEvent = {
  id: number;
  ip: string;
  /** blocked | bot | probe */
  kind: string;
  reason: string;
  host: string;
  method: string;
  uri: string;
  status: number;
  ua: string;
  hits: number;
  first_seen: string;
  last_seen: string;
};

export type SecuritySummary = {
  blocked: number;
  bot: number;
  probe: number;
  ips: number;
  window_hours: number;
};

export type SshRecord = {
  id: number;
  ts: number;
  time: string;
  ip: string;
  user: string;
  /** accepted | failed | invalid */
  result: string;
  method: string;
  port: number;
  raw: string;
};

export type SshSummary = {
  accepted: number;
  failed: number;
  invalid: number;
  ips: number;
  window_hours: number;
  top_failed: { ip: string; count: number }[];
};

async function one<T>(p: Promise<ApiResultType<T>>): Promise<T> {
  const res = await p;
  if (!res.success || res.data === undefined) throw new Error(res.message || i18n.t('security.load_failed'));
  return res.data;
}

export const fetchFirewall = () => one<Firewall>(get<Firewall>('/security/firewall'));

export const fetchEvents = (kind = '') =>
  one<SecurityEvent[]>(get<SecurityEvent[]>('/security/events', { kind, limit: 100 }));

export const fetchEventSummary = (hours = 24) =>
  one<SecuritySummary>(get<SecuritySummary>('/security/events/summary', { hours }));

export const fetchSshRecords = (result = '') =>
  one<SshRecord[]>(get<SshRecord[]>('/security/ssh', { result, limit: 200 }));

export const fetchSshSummary = (hours = 24 * 7) =>
  one<SshSummary>(get<SshSummary>('/security/ssh/summary', { hours }));

export const scanNow = () => post<{ inserted: number }>('/security/scan');
