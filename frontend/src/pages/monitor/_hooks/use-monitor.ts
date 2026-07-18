import { useEffect, useState } from 'react';
import { fetchMonitorData } from '../_api';
import type { ContainerInfo, DockerStatus, SysInfo } from '../_api';

export function formatBytes(b: number) {
  if (b >= 1 << 30) return (b / (1 << 30)).toFixed(1) + ' GB';
  if (b >= 1 << 20) return (b / (1 << 20)).toFixed(1) + ' MB';
  if (b >= 1 << 10) return (b / (1 << 10)).toFixed(1) + ' KB';
  return b + ' B';
}

export function formatUptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  return `${h}h ${m}m`;
}

export function useMonitor() {
  const [sys, setSys] = useState<SysInfo | null>(null);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [dockerSt, setDockerSt] = useState<DockerStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMonitorData()
      .then((data) => {
        setSys(data.sys);
        setContainers(data.containers);
        setDockerSt(data.docker);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return { sys, containers, dockerSt, loading };
}
