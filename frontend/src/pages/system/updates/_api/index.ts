import { get, post } from '../../../../lib/api';

export interface UpdatePackage {
  name: string;
  current: string;
  candidate: string;
  security: boolean;
}

export interface UpdateReport {
  distro: string;
  manager: string;
  supported: boolean;
  checked_at: string;
  total: number;
  security: number;
  packages: UpdatePackage[];
  message: string;
}

/** 读服务端缓存的检查结果（后台每 6 小时刷一次）。 */
export async function fetchUpdates() {
  const res = await get<UpdateReport>('/system/updates');
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

/** 立刻重新检查一次。 */
export async function checkUpdates() {
  const res = await post<UpdateReport>('/system/updates/check');
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

/** 装补丁。返回命令的原始输出，成功失败都给人看。 */
export async function applyUpdates(packages: string[]) {
  const res = await post<{ output: string }>('/system/updates/apply', { packages });
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data.output;
}
