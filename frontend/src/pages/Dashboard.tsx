import React, { useEffect, useState } from 'react';
import { apiGet } from '../main';

interface SysInfo {
  hostname: string;
  os: string;
  cpu_usage: number;
  cpu_cores: number;
  memory_total: number;
  memory_used: number;
  memory_percent: number;
  uptime_secs: number;
  disks: { mount: string; total: number; used: number; percent: number }[];
  processes: number;
}

interface Container {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
}

export default function Dashboard() {
  const [sys, setSys] = useState<SysInfo | null>(null);
  const [containers, setContainers] = useState<Container[]>([]);

  useEffect(() => {
    apiGet<SysInfo>('/system/overview').then(setSys).catch(() => {});
    apiGet<{ containers: Container[] }>('/services/')
      .then((d) => setContainers(d.containers))
      .catch(() => {});
  }, []);

  const bytes = (b: number) => {
    if (b >= 1 << 30) return (b / (1 << 30)).toFixed(1) + ' GB';
    if (b >= 1 << 20) return (b / (1 << 20)).toFixed(1) + ' MB';
    if (b >= 1 << 10) return (b / (1 << 10)).toFixed(1) + ' KB';
    return b + ' B';
  };

  const uptime = (s: number) => {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    return `${d}d ${h}h`;
  };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: 24 }}>
      <h1>Zenceglow Ops</h1>
      <p>{sys?.hostname} / {sys?.os}</p>

      <h2>系统概览</h2>
      {sys && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
          <Card label="CPU" value={`${sys.cpu_usage.toFixed(1)}% (${sys.cpu_cores}核)`} />
          <Card label="内存" value={`${bytes(sys.memory_used)} / ${bytes(sys.memory_total)} (${sys.memory_percent.toFixed(1)}%)`} />
          <Card label="进程" value={String(sys.processes)} />
          <Card label="运行时间" value={uptime(sys.uptime_secs)} />
        </div>
      )}

      <h2>磁盘</h2>
      {sys?.disks.map((d) => (
        <div key={d.mount} style={{ marginBottom: 8 }}>
          <strong>{d.mount}</strong> – {bytes(d.used)} / {bytes(d.total)} ({d.percent.toFixed(1)}%)
          <Bar pct={d.percent} />
        </div>
      ))}

      <h2>Docker 容器</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: '#f5f5f5' }}>
            <th>名称</th>
            <th>镜像</th>
            <th>状态</th>
            <th>端口</th>
          </tr>
        </thead>
        <tbody>
          {containers.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>{c.image}</td>
              <td>{c.status}</td>
              <td>{c.ports}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, textAlign: 'center' }}>
      <div style={{ fontSize: 12, color: '#888' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 'bold', marginTop: 4 }}>{value}</div>
    </div>
  );
}

function Bar({ pct }: { pct: number }) {
  return (
    <div style={{ background: '#eee', borderRadius: 4, height: 8, marginTop: 4 }}>
      <div style={{ background: pct > 80 ? '#e74c3c' : '#4caf50', width: `${Math.min(pct, 100)}%`, height: 8, borderRadius: 4 }} />
    </div>
  );
}
