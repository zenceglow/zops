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
  swap_total: number;
  swap_used: number;
  uptime_secs: number;
  load_avg: number[];
  processes: number;
  kernel: string;
  disks: { mount: string; total: number; used: number; percent: number }[];
  network: { name: string; rx_bytes: number; tx_bytes: number }[];
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiGet<SysInfo>('/system/overview'),
      apiGet<{ containers: Container[] }>('/services/'),
    ])
      .then(([s, svc]) => {
        setSys(s);
        setContainers(svc.containers);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-gray-400 dark:text-gray-500">加载中…</div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Zenceglow Ops</h1>
        {sys && (
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {sys.hostname} / {sys.os} &middot; {sys.kernel}
          </p>
        )}
      </div>

      {/* overview cards */}
      {sys && (
        <>
          <section className="mb-8">
            <h2 className="text-lg font-semibold mb-4 text-gray-800 dark:text-gray-200">
              系统概览
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Card label="CPU" value={`${sys.cpu_usage.toFixed(1)}%`} sub={`${sys.cpu_cores} 核`} />
              <Card
                label="内存"
                value={`${sys.memory_percent.toFixed(1)}%`}
                sub={`${bytes(sys.memory_used)} / ${bytes(sys.memory_total)}`}
              />
              <Card label="进程" value={String(sys.processes)} sub={`负载 ${sys.load_avg.map(n => n.toFixed(1)).join(' / ')}`} />
              <Card label="运行时间" value={uptime(sys.uptime_secs)} sub="uptime" />
            </div>
          </section>

          {/* disks */}
          <section className="mb-8">
            <h2 className="text-lg font-semibold mb-4 text-gray-800 dark:text-gray-200">
              磁盘
            </h2>
            <div className="space-y-3">
              {sys.disks.map((d) => (
                <div key={d.mount}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-medium text-gray-700 dark:text-gray-300">{d.mount}</span>
                    <span className="text-gray-500 dark:text-gray-400">
                      {bytes(d.used)} / {bytes(d.total)}
                    </span>
                  </div>
                  <Bar pct={d.percent} />
                </div>
              ))}
            </div>
          </section>

          {/* swap */}
          {sys.swap_total > 0 && (
            <section className="mb-8">
              <h2 className="text-lg font-semibold mb-4 text-gray-800 dark:text-gray-200">Swap</h2>
              <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5">
                  <div
                    className="h-2.5 rounded-full bg-yellow-500"
                    style={{ width: `${Math.min((sys.swap_used / sys.swap_total) * 100, 100)}%` }}
                  />
                </div>
                <span className="whitespace-nowrap">{bytes(sys.swap_used)} / {bytes(sys.swap_total)}</span>
              </div>
            </section>
          )}

          {/* network */}
          <section className="mb-8">
            <h2 className="text-lg font-semibold mb-4 text-gray-800 dark:text-gray-200">
              网络
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {sys.network.map((n) => (
                <div
                  key={n.name}
                  className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-800"
                >
                  <div className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{n.name}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    ↓ {bytes(n.rx_bytes)} &nbsp; ↑ {bytes(n.tx_bytes)}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {/* Docker containers */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-gray-800 dark:text-gray-200">
          Docker 容器 <span className="text-sm font-normal text-gray-400">({containers.length})</span>
        </h2>
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-100 dark:bg-gray-900 text-left text-gray-600 dark:text-gray-400">
                <th className="px-4 py-3 font-medium">名称</th>
                <th className="px-4 py-3 font-medium">镜像</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">端口</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
              {containers.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50 dark:hover:bg-gray-900/50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">{c.name}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400 max-w-xs truncate">{c.image}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium
                        ${c.state === 'running'
                          ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                        }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${c.state === 'running' ? 'bg-green-500' : 'bg-gray-400'}`} />
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">{c.ports || '-'}</td>
                </tr>
              ))}
              {containers.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-gray-400 dark:text-gray-500">
                    Docker 不可用或无容器
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/* ---------- reusable sub-components ---------- */

function Card({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 shadow-sm">
      <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</div>
      {sub && (
        <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">{sub}</div>
      )}
    </div>
  );
}

function Bar({ pct }: { pct: number }) {
  const color =
    pct > 90 ? 'bg-red-500' : pct > 75 ? 'bg-orange-500' : 'bg-blue-500';
  return (
    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
      <div
        className={`h-2 rounded-full transition-all ${color}`}
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  );
}
