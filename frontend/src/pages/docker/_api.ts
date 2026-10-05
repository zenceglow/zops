import { get } from '../../lib/api';
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

export type { ContainerInfo, DockerStatus };
