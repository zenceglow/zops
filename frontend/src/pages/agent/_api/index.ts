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

export function listTokens() {
  return get<ApiTokenInfo[]>('/token/list');
}

export function createToken(body: { name: string; scope: string }) {
  return post<ApiTokenCreated>('/token/create', body);
}

export function revokeToken(id: string) {
  return del<unknown>('/token', { id });
}

/**
 * Skill 接口在面板 JWT 组之外，但也接受面板 JWT。
 *
 * 注意它**不套 `{success, data}` 那层壳**，直接把文档摊平返回。之前按壳取值，
 * 于是 `r.success` 恒为 undefined，技能内容永远是空的、页面上一直显示"加载中"。
 */
export async function getSkill(): Promise<SkillInfo> {
  const res = (await get<SkillInfo>('/skill')) as unknown as SkillInfo;
  return { name: res?.name ?? '', filename: res?.filename ?? '', content: res?.content ?? '' };
}
