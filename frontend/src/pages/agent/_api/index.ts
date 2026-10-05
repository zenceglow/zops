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

/** Skill 接口在面板 JWT 组之外，但也接受面板 JWT。 */
export function getSkill() {
  return get<SkillInfo>('/skill');
}
