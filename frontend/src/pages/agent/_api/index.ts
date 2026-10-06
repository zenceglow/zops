import { del, get, post } from '../../../lib/api';

export type ApiTokenInfo = {
  id: string;
  name: string;
  prefix: string;
  /** `read` = 只能看；`write` = 还能启停容器、重载网关。 */
  scope: string;
  permissions: string[];
  created_at: string;
  last_used_at?: string;
};

/** `token` 只在创建时返回一次。 */
export type ApiTokenCreated = ApiTokenInfo & { token: string };

export type SkillInfo = {
  name: string;
  filename: string;
  content: string;
};

export type AgentTool = { name: string; description: string; level: 'read' | 'write' };

export function listTokens() {
  return get<ApiTokenInfo[]>('/token/list');
}

export function createToken(body: { name: string; scope: string }) {
  return post<ApiTokenCreated>('/token/create', body);
}

export function revokeToken(id: string) {
  return del('/token', { id });
}

/** 工具目录。MCP 自己的 `tools/list` 要 agent 令牌，面板页面用不了。 */
export async function getAgentTools() {
  const res = await get<{ tools: AgentTool[] }>('/agent/tools');
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data.tools;
}

/** agent 在这个面板上干过什么。数据来自审计日志（actor_kind = agent）。 */
export type AgentOp = {
  id: number;
  at: string;
  /** 令牌名 —— 哪个 agent 干的。 */
  actor: string;
  tool: string;
  level: 'read' | 'write';
  ok: boolean;
  summary: string;
  detail: string;
};

export async function getAgentOps(limit = 120): Promise<AgentOp[]> {
  const res = await get<AgentOp[]>('/agent/ops', { limit });
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

/**
 * 技能原文。
 *
 * 注意这个接口**不套 `{success, data}` 那层壳**，直接把文档摊平返回。按壳取值会
 * 让 `success` 恒为 undefined，内容永远是空的。
 */
export async function getSkill(): Promise<SkillInfo> {
  const res = (await get<SkillInfo>('/skill')) as unknown as SkillInfo;
  return { name: res?.name ?? '', filename: res?.filename ?? '', content: res?.content ?? '' };
}
