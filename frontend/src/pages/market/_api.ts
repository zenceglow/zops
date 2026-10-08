import { get, post } from '../../lib/api';
import i18n from '../../i18n/i18n';
import type { DeployJob, DeployRun } from '../deploy/_api';

/**
 * 应用市场。
 *
 * 装出来的东西**就是部署任务**（同一批记录、同一个日志通道），所以这里不重造一套
 * 执行相关的类型，直接从部署页借 `DeployJob` / `DeployRun` / `readRunLog` —— 两处
 * 各写一份必然漂移。
 */

export type AppPort = {
  /** 回传用户填值时的键。 */
  key: string;
  label: string;
  label_en: string;
  /** 容器内端口，只读 —— 改了容器里的服务根本不会去听。 */
  container: number;
  host_default: number;
  hint: string;
  hint_en: string;
};

export type AppEnv = {
  key: string;
  label: string;
  label_en: string;
  default: string;
  /** 密码类：用密码框。 */
  secret: boolean;
  required: boolean;
  /** 最短长度，0 表示不限。MinIO 少于 8 位容器会直接退出。 */
  min_len: number;
  hint: string;
  hint_en: string;
};

export type AppVolume = {
  host: string;
  container: string;
  label: string;
  label_en: string;
};

export type InstalledApp = {
  job_id: string;
  name: string;
  dir: string;
  /** draft | running | success | failed */
  status: string;
  network: string;
  ports: Record<string, number>;
  container_id: string | null;
  last_run_at: string | null;
  last_exit_code: number | null;
};

export type MarketApp = {
  id: string;
  name: string;
  tagline: string;
  tagline_en: string;
  /** database | cache | storage */
  category: string;
  image: string;
  version: string;
  homepage: string;
  docs: string;
  license: string;
  default_name: string;
  ports: AppPort[];
  env: AppEnv[];
  volumes: AppVolume[];
  notes: string[];
  notes_en: string[];
  /** 装过就有，没装过是 null。 */
  installed: InstalledApp | null;
};

export type InstallOptions = {
  app: string;
  name?: string;
  network?: string;
  ports?: Record<string, number>;
  env?: Record<string, string>;
};

export type InstallPlan = {
  app: string;
  name: string;
  network: string;
  image: string;
  /** 渲染好的 compose，**密码已遮成 `******`**。 */
  compose: string;
  script: string;
  /** 会在部署目录里建的子目录。 */
  volumes: string[];
  /** 端口被占、网络不存在这类"能装但会出问题"的提醒。 */
  warnings: string[];
  dir: string;
};

export type InstallResult = {
  job: DeployJob;
  run: DeployRun;
};

/** 列表里挑文案：清单里的每个字符串都有中英两版，后端不猜前端用什么语言。 */
export function localized(zh: string, en: string): string {
  return i18n.language.startsWith('zh') ? zh : en;
}

export async function fetchApps(): Promise<MarketApp[]> {
  const res = await get<MarketApp[]>('/app/list');
  if (!res.success || !res.data) throw new Error(res.message || i18n.t('market.err.load'));
  return res.data;
}

export async function planApp(opts: InstallOptions): Promise<InstallPlan> {
  const res = await post<InstallPlan>('/app/plan', opts);
  if (!res.success || !res.data) throw new Error(res.message || i18n.t('market.err.plan'));
  return res.data;
}

export async function installApp(opts: InstallOptions): Promise<InstallResult> {
  const res = await post<InstallResult>('/app/install', opts);
  if (!res.success || !res.data) throw new Error(res.message || i18n.t('market.err.install'));
  return res.data;
}
