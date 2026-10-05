import { del, get, post } from '../../lib/api';

export type Channel = {
  id: string;
  name: string;
  kind: string;
  events: string[];
  enabled: boolean;
  created_at: string;
  last_at: string | null;
  last_ok: boolean | null;
  last_error: string;
  /** 打码后的地址，列表上用。 */
  url_masked: string;
  /** 原文，编辑时要看得到。 */
  url: string;
  has_secret: boolean;
  secret: string;
};

export type ChannelInput = {
  id?: string;
  name: string;
  kind: string;
  url: string;
  secret: string;
  events: string[];
  enabled: boolean;
};

export type NotifyLog = {
  id: number;
  at: string;
  channel: string;
  kind: string;
  event: string;
  ok: boolean;
  status: number;
  detail: string;
};

export type EventDef = { key: string; label: string };

/**
 * 各家机器人的接入位置。
 *
 * 放在代码里而不是后端：这是"去哪儿点几下"的说明书，不是数据。用户照着填一次
 * 就再也不会看了，没必要为它设计一套配置。
 */
export const KINDS = [
  { key: 'feishu', label: '飞书', placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…' },
  { key: 'dingtalk', label: '钉钉', placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=…' },
  { key: 'wecom', label: '企业微信', placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…' },
  { key: 'slack', label: 'Slack', placeholder: 'https://hooks.slack.com/services/…' },
  { key: 'discord', label: 'Discord', placeholder: 'https://discord.com/api/webhooks/…' },
  { key: 'telegram', label: 'Telegram', placeholder: 'https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>' },
  { key: 'generic', label: '通用 Webhook', placeholder: 'https://your-service/hooks/zops' },
] as const;

export async function fetchChannels() {
  const res = await get<Channel[]>('/notify/channels');
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

export async function fetchEvents() {
  const res = await get<EventDef[]>('/notify/events');
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

export async function fetchLog() {
  const res = await get<NotifyLog[]>('/notify/log');
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

export async function saveChannel(input: ChannelInput) {
  const res = await post<Channel>('/notify/channels', input);
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

export async function toggleChannel(id: string, enabled: boolean) {
  const res = await post('/notify/channels/toggle', { id, enabled });
  if (!res.success) throw new Error(res.message || 'Failed');
}

export async function removeChannel(id: string) {
  const res = await del('/notify/channels/remove', { id });
  if (!res.success) throw new Error(res.message || 'Failed');
}

/// 试发一条。失败时后端会把对方回的原话带回来。
export async function testChannel(id: string) {
  const res = await post('/notify/test', { id });
  if (!res.success) throw new Error(res.message || 'Failed');
}
