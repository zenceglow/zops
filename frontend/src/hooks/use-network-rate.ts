import { useEffect, useRef, useState } from 'react';
import { get } from '../lib/api';
import type { SysInfo } from '../pages/monitor/_api';

const POLL_MS = 2000;
/** 保留最近 60 个采样点 ≈ 2 分钟，够画一条能看出起伏的曲线。 */
const HISTORY = 60;

export type IfaceRate = {
  name: string;
  rx: number;
  tx: number;
  rxTotal: number;
  txTotal: number;
};

export type NetStats = {
  /** 主网卡合计，单位 B/s。 */
  rxRate: number;
  txRate: number;
  rxTotal: number;
  txTotal: number;
  ifaces: IfaceRate[];
  /** 最近若干次采样的瞬时速率，用于画 sparkline。 */
  history: { rx: number; tx: number }[];
};

/**
 * 跳过 loopback / 虚拟 / Apple 私有接口。
 * 与首页、网络页共用，避免两处口径不一致（一边算 en0 一边算上 utun 就白比了）。
 */
export function isPrimaryIface(name: string) {
  const n = name.toLowerCase();
  if (n === 'lo' || n.startsWith('lo')) return false;
  return !/^(utun|awdl|llw|bridge|veth|docker|br-|virbr|vmnet|vnic|ap\d|gif|stf|p2p)/.test(n);
}

/**
 * 实时网络速率。
 *
 * 后端给的 `rx_bytes/tx_bytes` 是**自开机累计**值，所以瞬时速率只能靠两次采样
 * 做差分。刻意不为它加后端接口：差值算在前端既不用改协议，也能顺手拿到
 * 采样历史去画曲线。
 */
export function useNetworkRate(enabled = true): NetStats | null {
  const [stats, setStats] = useState<NetStats | null>(null);
  const prev = useRef<{ t: number; byName: Map<string, { rx: number; tx: number }> } | null>(null);
  const history = useRef<{ rx: number; tx: number }[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;

    const tick = async () => {
      const res = await get<SysInfo>('/system/overview').catch(() => null);
      if (!alive || !res?.success || !res.data) return;

      // 只留下真的搬过字节的接口：macOS 上 en0..en5 / 各种虚拟网卡常年是 0，
      // 全算进来会得到"10 张网卡"这种没信息量的数字。
      const primary = res.data.network.filter(
        (n) => isPrimaryIface(n.name) && n.rx_bytes + n.tx_bytes > 0,
      );
      const now = Date.now();
      const byName = new Map(primary.map((n) => [n.name, { rx: n.rx_bytes, tx: n.tx_bytes }]));

      let rxRate = 0;
      let txRate = 0;
      const perName = new Map<string, { rx: number; tx: number }>();
      if (prev.current) {
        // 计数器是单调递增的；除以真实间隔而不是假定的 2s，定时器抖动才不至于把速率算歪。
        const dt = Math.max((now - prev.current.t) / 1000, 0.2);
        for (const [name, cur] of byName) {
          const before = prev.current.byName.get(name);
          if (!before) continue;
          // 接口在这两次采样之间被重置过（计数器归零）时不产生负速率。
          const rx = Math.max(0, cur.rx - before.rx) / dt;
          const tx = Math.max(0, cur.tx - before.tx) / dt;
          perName.set(name, { rx, tx });
          rxRate += rx;
          txRate += tx;
        }
      }

      prev.current = { t: now, byName };
      history.current = [...history.current, { rx: rxRate, tx: txRate }].slice(-HISTORY);

      setStats({
        rxRate,
        txRate,
        rxTotal: primary.reduce((s, n) => s + n.rx_bytes, 0),
        txTotal: primary.reduce((s, n) => s + n.tx_bytes, 0),
        ifaces: primary.map((n) => ({
          name: n.name,
          rx: perName.get(n.name)?.rx ?? 0,
          tx: perName.get(n.name)?.tx ?? 0,
          rxTotal: n.rx_bytes,
          txTotal: n.tx_bytes,
        })),
        history: history.current,
      });
    };

    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [enabled]);

  return stats;
}

export function formatRate(bytesPerSec: number) {
  if (bytesPerSec >= 1 << 20) return (bytesPerSec / (1 << 20)).toFixed(1) + ' MB/s';
  if (bytesPerSec >= 1 << 10) return (bytesPerSec / (1 << 10)).toFixed(0) + ' KB/s';
  return Math.round(bytesPerSec) + ' B/s';
}
