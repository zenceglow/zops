import { del, get, post, put } from '../../lib/api';
import type { ContainerInfo, DockerStatus } from '../../pages/monitor/_api/types';

export type DockerImage = {
  id: string;
  tags: string[];
  size: number;
  created: number;
  containers: number;
  /** 没有 tag 的悬空镜像 —— "垃圾"那一类。 */
  dangling: boolean;
};

export type ImageList = { images: DockerImage[]; dangling_size: number };

export type DockerNetwork = {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  containers: number;
  subnet: string;
};

export type NetworkList = { networks: DockerNetwork[] };

export type DockerInfo = {
  available: boolean;
  info: Record<string, unknown> | null;
  version: Record<string, unknown> | null;
};

export async function fetchImages() {
  const res = await get<ImageList>('/service/images');
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

export async function fetchNetworks() {
  const res = await get<NetworkList>('/service/networks');
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

export async function fetchDockerInfo() {
  const res = await get<DockerInfo>('/service/info');
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

export async function fetchContainers() {
  const [list, status] = await Promise.all([
    get<{ containers: ContainerInfo[] }>('/service/list'),
    get<DockerStatus>('/service/status'),
  ]);
  if (!list.success || !list.data) throw new Error(list.message || 'Failed');
  return { containers: list.data.containers, status: status.data ?? null };
}

/** 启停重启删容器。四个动作各一个接口，语义清清楚楚，不做成一个 action 参数。 */
export async function containerAction(
  id: string,
  action: 'start' | 'stop' | 'restart' | 'remove',
) {
  const res =
    action === 'remove'
      ? await del(`/service/?id=${encodeURIComponent(id)}`)
      : await post(`/service/${action}`, { id });
  if (!res.success) throw new Error(res.message || 'Failed');
  return res.message;
}

export type DaemonFile = {
  path: string;
  exists: boolean;
  content: string;
  can_write: boolean;
  mirrors: string[];
  insecure_registries: string[];
};

export type DaemonWriteResult = {
  path: string;
  backup: string | null;
  restarted: boolean;
  message: string;
};

export async function fetchDaemon() {
  const res = await get<DaemonFile>('/service/daemon');
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

/** 写引擎配置。后端会先校验 JSON、备份原文件，然后重启 Docker。 */
export async function saveDaemon(content: string) {
  const res = await put<DaemonWriteResult>('/service/daemon', { content });
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

/** 删镜像。force 会连带删掉用它的容器，界面上必须先确认。 */
export async function removeImage(reference: string, force = false) {
  const res = await del(
    `/service/images?reference=${encodeURIComponent(reference)}${force ? '&force=true' : ''}`,
  );
  if (!res.success) throw new Error(res.message || 'Failed');
  return res.data;
}

export type { ContainerInfo, DockerStatus };
