import { apiGet } from '../../../lib/api';
import type { ContainerInfo, DockerStatus, MonitorData, SysInfo } from './types';

export async function fetchMonitorData(): Promise<MonitorData> {
  const [sys, svc, docker] = await Promise.all([
    apiGet<SysInfo>('/system/overview'),
    apiGet<{ containers: ContainerInfo[] }>('/services'),
    apiGet<DockerStatus>('/services/status'),
  ]);
  return { sys, containers: svc.containers, docker };
}

export type { ContainerInfo, DockerStatus, MonitorData, SysInfo };
