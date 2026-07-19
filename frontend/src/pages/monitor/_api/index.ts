import { get } from '../../../lib/api';
import type { ContainerInfo, DockerStatus, SysInfo } from './types';

export async function fetchMonitorData() {
  const [sys, containers, docker] = await Promise.all([
    get<SysInfo>('/system/overview'),
    get<{ containers: ContainerInfo[] }>('/service/list'),
    get<DockerStatus>('/service/status'),
  ]);

  if (!sys.success || !sys.data) throw new Error(sys.message || 'Failed to load system');
  if (!containers.success || !containers.data) {
    throw new Error(containers.message || 'Failed to load containers');
  }
  if (!docker.success || !docker.data) throw new Error(docker.message || 'Failed to load docker');

  return {
    sys: sys.data,
    containers: containers.data.containers,
    docker: docker.data,
  };
}

export type { ContainerInfo, DockerStatus, SysInfo } from './types';
