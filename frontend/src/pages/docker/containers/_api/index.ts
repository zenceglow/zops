import { get } from '../../../../lib/api';
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

export type { ContainerInfo, DockerStatus };
