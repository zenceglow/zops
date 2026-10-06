import { useCallback, useEffect, useState } from 'react';
import { fetchContainers, type ContainerInfo, type DockerStatus } from '../_api';

export function useContainers() {
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [docker, setDocker] = useState<DockerStatus | null>(null);
  const [loading, setLoading] = useState(true);

  /** 动作之后要重新读一遍 —— 启停是新状态，不重读界面会停在旧的那一版。 */
  const reload = useCallback(() => {
    fetchContainers()
      .then((d) => {
        setContainers(d.containers);
        setDocker(d.docker);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { containers, docker, loading, reload };
}
