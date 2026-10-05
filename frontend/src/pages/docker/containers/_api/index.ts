import { get, post } from '../../../../lib/api';
import type { ContainerInfo, DockerStatus } from '../../../../pages/monitor/_api/types';

/**
 * 容器列表与 Docker 引擎状态。
 *
 * 类型复用 monitor 页的那份：这两个接口本来就是同一套领域对象，
 * 复制一份定义迟早两边不一致。真要拆，应该整体搬到 lib/types。
 */
export async function fetchContainers() {
  const [containers, docker] = await Promise.all([
    get<{ containers: ContainerInfo[] }>('/service/list'),
    get<DockerStatus>('/service/status'),
  ]);
  return {
    containers: containers.success && containers.data ? containers.data.containers : [],
    docker: docker.success && docker.data ? docker.data : null,
  };
}

/** 单个容器：列表接口本来就带全量字段，前端挑一个即可，不必再加接口。 */
export async function fetchContainer(id: string) {
  const { containers, docker } = await fetchContainers();
  return { container: containers.find((c) => c.id === id) ?? null, docker };
}

export async function fetchContainerLogs(id: string, tail = 300) {
  // 后端给的是 `{ logs: ["一行", "一行"] }`，不是裸数组 —— 一开始按数组解析，
  // 结果每个容器都显示"暂无日志输出"，包括明明有日志的。
  const res = await get<{ logs?: string[] }>(`/service/log?id=${encodeURIComponent(id)}&tail=${tail}`);
  if (!res.success) throw new Error(res.message || 'Failed');
  const lines = res.data?.logs;
  return Array.isArray(lines) ? lines.join('\n') : '';
}

export async function containerAction(id: string, action: 'start' | 'stop' | 'restart') {
  const res = await post(`/service/${action}`, { id });
  if (!res.success) throw new Error(res.message || 'Failed');
}

export type { ContainerInfo, DockerStatus };
