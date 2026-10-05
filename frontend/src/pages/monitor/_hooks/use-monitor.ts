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

/** 首页的刷新间隔。资源占用是"现在"的数，打开页面拉一次就不再变很没意义。 */
const REFRESH_MS = 10_000;

export function useMonitor() {
  const [sys, setSys] = useState<SysInfo | null>(null);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [dockerSt, setDockerSt] = useState<DockerStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    let first = true;

    const load = async () => {
      try {
        const data = await fetchMonitorData();
        if (!alive) return;
        setSys(data.sys);
        setContainers(data.containers);
        setDockerSt(data.docker);
      } catch {
        // 轮询失败时保留上一帧：网络抖一下就把整页清空，比数字暂时停住更糟。
      } finally {
        if (first) {
          first = false;
          if (alive) setLoading(false);
        }
      }
    };

    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return { sys, containers, dockerSt, loading };
}
