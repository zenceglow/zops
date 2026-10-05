import { useEffect, useState } from 'react';
import { fetchContainers, type ContainerInfo, type DockerStatus } from '../_api';

export function useContainers() {
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [docker, setDocker] = useState<DockerStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchContainers()
      .then((d) => {
        setContainers(d.containers);
        setDocker(d.docker);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return { containers, docker, loading };
}
