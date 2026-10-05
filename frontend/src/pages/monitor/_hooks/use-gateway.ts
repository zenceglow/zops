import { useEffect, useState } from 'react';
import { fetchGatewayConfig, fetchGatewayStatus } from '../../sites/_api';
import type { GatewayStatus, SiteEntry } from '../../sites/_api';

/**
 * 首页要用的网关信息：状态 + 站点入口。
 *
 * 提到页面级是因为"站点入口"卡片和下面的拓扑图都要它 —— 各自拉一遍的话，
 * 同一个接口在一次渲染里要打两次，而且某一边刷新了另一边还是旧的。
 */
export function useGatewayEntries() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [sites, setSites] = useState<SiteEntry[]>([]);
  // 请求结束（无论成败）后就不再显示骨架：否则网关没装、或接口挂了，首页会永远
  // 挂着一个"加载中"的占位，比"这块没有"更让人困惑。
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetchGatewayStatus().catch(() => null),
      fetchGatewayConfig().catch(() => null),
    ]).then(([st, cfg]) => {
      if (!alive) return;
      setStatus(st);
      setSites(cfg?.parsed.sites ?? []);
      setSettled(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  return { status, sites, settled };
}
