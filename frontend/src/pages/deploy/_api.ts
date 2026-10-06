import { del, get, post, put } from '../../lib/api';
import useAuthorizeStore from '../../stores/authorize.store';
import i18n from '../../i18n/i18n';

/** 面板令牌存在 zustand 里（可能被 secure-storage 加密过），统一从这里取。 */
function authHeader(): Record<string, string> {
  const token = useAuthorizeStore.getState().token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type DeployFile = {
  path: string;
  size: number;
  uploaded_at: string;
  uploaded_by: string;
};

export type DeployJob = {
  id: string;
  name: string;
  note: string;
  script: string;
  /** manual | agent —— 这个任务是面板上建的，还是 agent 建的。 */
  source: string;
  /** draft | running | success | failed */
  status: string;
  actor: string;
  actor_kind: string;
  dir: string;
  container_name?: string | null;
  container_id?: string | null;
  last_run_at?: string | null;
  last_exit_code?: number | null;
  last_duration_ms?: number | null;
  created_at: string;
  updated_at: string;
  files: DeployFile[];
};

export type DeployRun = {
  id: string;
  job_id: string;
  status: string;
  actor: string;
  actor_kind: string;
  output: string;
  exit_code?: number | null;
  started_at: string;
  finished_at?: string | null;
  duration_ms?: number | null;
};

export type RunLog = {
  status: string;
  output: string;
  offset: number;
  finished: boolean;
  exit_code?: number | null;
};

export async function listJobs(): Promise<DeployJob[]> {
  const res = await get<DeployJob[]>('/deploy/jobs');
  if (!res.success || !res.data) throw new Error(res.message || i18n.t('deploy.err_load'));
  return res.data;
}

/** 机器上真实在跑的服务（容器）。「应用与服务」列的就是它们。 */
export type ServiceContainer = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
};

export async function listServices(): Promise<ServiceContainer[]> {
  const res = await get<{ containers: ServiceContainer[] }>('/service/list');
  if (!res.success || !res.data) throw new Error(res.message || i18n.t('deploy.err_load'));
  return res.data.containers;
}

export async function createJob(
  name: string,
  note: string,
  /** frontend（静态站，不发布宿主端口）| backend（发布一个宿主端口） */
  kind: 'frontend' | 'backend' = 'backend',
  /** 后端端口；留空由服务端从 8000-9999 挑一个空着的 */
  port?: number,
): Promise<DeployJob> {
  const res = await post<DeployJob>('/deploy/jobs', {
    name,
    note,
    source: 'manual',
    kind,
    port: port || null,
  });
  if (!res.success || !res.data) throw new Error(res.message || i18n.t('deploy.create_failed'));
  return res.data;
}

export async function deleteJob(id: string): Promise<void> {
  const res = await del('/deploy/job', { id });
  if (!res.success) throw new Error(res.message || i18n.t('deploy.err_delete'));
}

export async function saveScript(id: string, script: string): Promise<DeployJob> {
  const res = await put<DeployJob>('/deploy/job/script', { id, script });
  if (!res.success || !res.data) throw new Error(res.message || i18n.t('deploy.err_save'));
  return res.data;
}

export async function deleteFile(id: string, path: string): Promise<DeployJob> {
  const res = await post<DeployJob>('/deploy/job/file', { id, path });
  if (!res.success || !res.data) throw new Error(res.message || i18n.t('deploy.err_delete'));
  return res.data;
}

/** 执行部署。走 POST + 查询参数，lib/api 的 post 只带 body，这里自己拼。 */
export async function runJob(id: string): Promise<DeployRun> {
  const url = `/api/ops/deploy/job/run?id=${encodeURIComponent(id)}`;
  const res = await fetch(url, { method: 'POST', headers: authHeader() });
  const body = (await res.json()) as { success: boolean; message: string; data: DeployRun };
  if (!body.success || !body.data) throw new Error(body.message || i18n.t('deploy.err_run'));
  return body.data;
}

export async function listRuns(id: string, limit = 30): Promise<DeployRun[]> {
  const res = await get<DeployRun[]>('/deploy/job/runs', { id, limit });
  if (!res.success || !res.data) throw new Error(res.message || i18n.t('deploy.err_runs'));
  return res.data;
}

export async function readRunLog(id: string, offset: number): Promise<RunLog> {
  const res = await get<RunLog>('/deploy/run/log', { id, offset });
  if (!res.success || !res.data) throw new Error(res.message || i18n.t('deploy.err_log'));
  return res.data;
}

/**
 * 上传产物。走原始 body（不是 multipart），所以用 XHR 才能拿到进度 ——
 * 前端产物动辄几十 MB，没有进度条就是在盲等。
 */
export function uploadFile(
  id: string,
  path: string,
  file: File,
  onProgress: (loaded: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(
      'POST',
      `/api/ops/deploy/job/upload?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`,
    );
    for (const [k, v] of Object.entries(authHeader())) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as { success: boolean; message: string };
        if (xhr.status >= 200 && xhr.status < 300 && body.success) resolve();
        else reject(new Error(body.message || i18n.t('deploy.err_upload', { code: xhr.status })));
      } catch {
        reject(new Error(i18n.t('deploy.err_upload', { code: xhr.status })));
      }
    };
    xhr.onerror = () => reject(new Error(i18n.t('deploy.err_network')));
    xhr.send(file);
  });
}
