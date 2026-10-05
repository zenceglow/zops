import { useEffect, useState } from 'react';
import { FileText, Globe } from 'lucide-react';
import { get } from '../lib/api';

/**
 * 站点入口的图标。
 *
 * 规则按入口的**性质**分，不是按好看：
 * - 反向代理：一个地球。代理站点自己没页面，拿不到图标，而"这是个入口"这件事
 *   地球说得最准。
 * - 静态文件：去找它自己的 favicon / logo。这类站点就是一张网页，露出它自己的
 *   图标，一眼能认出是哪个站；找不到再退回文件图标。
 * - 其他：文件图标。
 *
 * 图标由**服务端**去取（`/gateway/icon`），不是浏览器直连 —— 面板常挂在
 * `http://IP:5200` 上，站点可能是 https，也可能只有服务器解析得了。
 */
export function SiteGlyph({
  addr,
  kind,
  size = 24,
}: {
  addr: string;
  kind: 'proxy' | 'static' | 'other' | string;
  /** 图标的边长（px），外层的圆角方块由调用方给。 */
  size?: number;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    if (kind !== 'static') return;
    let alive = true;
    setSrc(null);
    setBroken(false);
    void get<{ data_url: string | null }>(`/gateway/icon?host=${encodeURIComponent(addr)}`)
      .then((res) => {
        if (alive && res.success && res.data?.data_url) setSrc(res.data.data_url);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [addr, kind]);

  // 拿不到 favicon 不是错误，退回一个中性图标就是了 —— 有些站点真没有。
  if (kind === 'static' && src && !broken) {
    return (
      <img
        src={src}
        alt=""
        style={{ width: size, height: size }}
        className="rounded-[4px] object-contain"
        onError={() => setBroken(true)}
      />
    );
  }

  const Icon = kind === 'proxy' ? Globe : FileText;
  return <Icon style={{ width: size, height: size }} />;
}
