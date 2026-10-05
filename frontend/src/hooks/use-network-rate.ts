import { useEffect, useRef, useState } from 'react';
import { get } from '../lib/api';
import type { SysInfo } from '../pages/monitor/_api';

const POLL_MS = 2000;
/** 保留最近 60 个采样点 ≈ 2 分钟，够画一条能看出起伏的曲线。 */
export const NET_HISTORY_SIZE = 60;

/**
 * 曲线存在浏览器会话里。
 *
 * 速率是"两次采样的差值"，只能在前端算，后端没有历史可查 —— 于是刷新一下
 * 页面，攒了两分钟的曲线就没了。存 sessionStorage 而不是 localStorage：它
 * 跟着标签页走，关掉标签页即清空，不会把几天前的旧趋势拿来配今天的数据。
 */
const STORAGE_KEY = 'zops:net-rate-history:v1';
/**
 * 恢复时的断档上限。
 *
 * 不能按"绝对年龄"来裁剪：缓冲区本来就是 2 分钟，若只留最近 1 分钟，每次刷新
 * 曲线都会凭空短一截，看起来就像"还是没存住"。改成只看**最后一点距今多久** ——
 * 普通刷新只差一两秒，整条曲线原样接上；笔记本休眠后回来再看，最后一点已是
 * 十分钟前，这时候才整段丢弃，免得多出一条跨越空洞的假折线。
 */
const MAX_GAP_MS = 30_000;

type Sample = { t: number; rx: number; tx: number };

function loadHistory(): Sample[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const tail = parsed
      .filter(
        (p): p is Sample =>
          !!p &&
          typeof p.t === 'number' &&
          typeof p.rx === 'number' &&
          typeof p.tx === 'number',
      )
      .slice(-NET_HISTORY_SIZE);
    const last = tail[tail.length - 1];
    if (!last || Date.now() - last.t > MAX_GAP_MS) return [];
    return tail;
  } catch {
    return [];
  }
}

function saveHistory(points: Sample[]) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(points.slice(-NET_HISTORY_SIZE)));
  } catch {
    // 无痕模式 / 配额已满：存不下就让曲线退化成"仅本次会话有效"，不该因此报错。
  }
}

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
  const history = useRef<Sample[] | null>(null);
  // 懒加载：只在首次渲染读一次会话存储，effect 因 enabled 变化重跑时不该再读。
  if (history.current === null) history.current = loadHistory();

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

      // 首次采样没有前值可差分，此时 rxRate/txRate 恒为 0，记进去会在曲线开头
      // 留下一个掉到底的假尖点，所以只在真正算出速率之后才落点。
      const first = prev.current === null;
      prev.current = { t: now, byName };
      if (!first) {
        const points = [...(history.current ?? []), { t: now, rx: rxRate, tx: txRate }].slice(
          -NET_HISTORY_SIZE,
        );
        history.current = points;
        saveHistory(points);
      }

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
        history: (history.current ?? []).map(({ rx, tx }) => ({ rx, tx })),
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
