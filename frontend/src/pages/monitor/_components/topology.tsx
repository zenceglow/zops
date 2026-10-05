import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { ContainerInfo } from '../_api';
import type { SiteEntry } from '../../sites/_api';
import { summarizeSite } from '../../sites/_lib/site-summary';
import { cn } from '../../../lib/utils';

const W = 1000;
const H = 380;
const GLOBE = { x: 108, y: H / 2, r: 64 };
const ENTRY_X = 400;
const CONTAINER_X = 790;

type Node = { key: string; label: string; sub: string };

/**
 * 系统里开了"减少动态效果"就别转动画。
 *
 * CSS 的 @media (prefers-reduced-motion) 管得住虚线流动，但管不住 SMIL
 * （地球经络那个 `<animate>`）—— 那是 XML 里的动画元素，只能靠不渲染它来关掉。
 */
function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * 请求怎么从外网走到容器里。
 *
 * 三段：地球（外面）→ 站点入口（Caddy 上的域名）→ 容器（真正干活的进程）。
 * 中间那步是**按端口匹配**的：入口里的 `reverse_proxy localhost:9082` 去找哪个容器
 * 把 9082 发布出来了 —— 这正是排查 502 时要顺着走的路径，图上看得见的话，就不用在
 * 配置文件、docker ps 和容器日志之间来回翻了。
 *
 * 用 SVG + CSS 画，没上动画库：这里要的动画只有"虚线流动"和"地球经络转动"两种，
 * 引入 framer-motion / three.js 是为了两行动画背几百 KB，不划算。
 */
export function Topology({
  entries,
  containers,
}: {
  entries: SiteEntry[];
  containers: ContainerInfo[];
}) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();

  // —— 数据：入口 → 目标端口 → 容器 ——
  const entryNodes: (Node & { port: string | null; url: string | null })[] = entries
    .slice(0, 6)
    .map((s) => {
      const info = summarizeSite(s);
      // `localhost:9082` / `127.0.0.1:9082` / 纯端口，都取冒号后面那段数字。
      const port = info.target.match(/:(\d+)\s*$/)?.[1] ?? null;
      return { key: s.addr, label: s.addr, sub: info.target || t('sites.kind_other'), port, url: info.url };
    });

  const running = containers.filter((c) => c.state === 'running').slice(0, 8);
  const containerNodes: (Node & { port: string | null })[] = running.map((c) => {
    const host = c.ports.match(/:(\d+)-\d+/)?.[1] ?? null;
    return { key: c.id, label: c.image, sub: host ? `: ${host}` : '—', port: host };
  });

  const spread = (count: number) => {
    if (count <= 0) return [];
    if (count === 1) return [H / 2];
    const top = 64;
    const step = (H - top * 2) / (count - 1);
    return Array.from({ length: count }, (_, i) => top + step * i);
  };
  const entryY = spread(entryNodes.length);
  const containerY = spread(containerNodes.length);

  // 端口匹配：入口指向哪个端口，就连到发布了那个端口的容器上。
  const links = entryNodes.map((e) => {
    const target = e.port
      ? containerNodes.findIndex((c) => c.port === e.port)
      : -1;
    return { entry: e, targetIndex: target };
  });

  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = (x2 - x1) * 0.45;
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  };

  return (
    <div className="rounded-2xl border border-border/60 px-4 py-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[300px] w-full sm:h-[340px]" role="img" aria-label={t('topology.title')}>
        <defs>
          <radialGradient id="globe-fill" cx="38%" cy="32%">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.06" />
          </radialGradient>
        </defs>

        {/* 地球：一圈本体 + 会呼吸的光晕 + 转动的经络 */}
        <g className="text-sky-500">
          <circle cx={GLOBE.x} cy={GLOBE.y} r={GLOBE.r + 10} className="fill-sky-500/5 animate-breathe" />
          <circle cx={GLOBE.x} cy={GLOBE.y} r={GLOBE.r} fill="url(#globe-fill)" className="stroke-sky-500/40" />
          {[0.9, 0.6, 0.28].map((k, i) => (
            <ellipse
              key={k}
              cx={GLOBE.x}
              cy={GLOBE.y}
              ry={GLOBE.r}
              className="fill-none stroke-sky-500/50"
              strokeWidth="1"
            >
              {/* 经络的横半径来回收放 = 球在自转，比整体旋转更像球体 */}
              {!reducedMotion && (
                <animate
                  attributeName="rx"
                  values={`${GLOBE.r * k};0;${GLOBE.r * k};0;${GLOBE.r * k}`}
                  dur="14s"
                  begin={`${i * 1.2}s`}
                  repeatCount="indefinite"
                />
              )}
            </ellipse>
          ))}
          {/* 纬线 */}
          {[-0.5, 0, 0.5].map((k) => (
            <line
              key={k}
              x1={GLOBE.x - GLOBE.r * Math.sqrt(1 - k * k)}
              y1={GLOBE.y + GLOBE.r * k}
              x2={GLOBE.x + GLOBE.r * Math.sqrt(1 - k * k)}
              y2={GLOBE.y + GLOBE.r * k}
              className="stroke-sky-500/35"
              strokeWidth="1"
            />
          ))}
        </g>

        {/* 地球 → 入口 */}
        {entryNodes.map((e, i) => {
          const d = curve(GLOBE.x + GLOBE.r - 6, GLOBE.y, ENTRY_X - 6, entryY[i]);
          return (
            <g key={e.key}>
              <path d={d} className="topology-edge fill-none stroke-sky-500/50" strokeWidth="1.2" />
              {!reducedMotion && (
                <circle r="2.6" className="fill-sky-400">
                  <animateMotion dur={`${2.6 + i * 0.35}s`} repeatCount="indefinite" path={d} />
                </circle>
              )}
            </g>
          );
        })}

        {/* 入口 → 容器（按端口匹配） */}
        {links.map(({ entry, targetIndex }, i) => {
          if (targetIndex < 0) return null;
          const d = curve(ENTRY_X + 6, entryY[i], CONTAINER_X - 6, containerY[targetIndex]);
          return (
            <g key={`${entry.key}-link`}>
              <path d={d} className="topology-edge fill-none stroke-emerald-500/45" strokeWidth="1.2" />
              {!reducedMotion && (
                <circle r="2.4" className="fill-emerald-400">
                  <animateMotion dur={`${3 + i * 0.4}s`} repeatCount="indefinite" path={d} />
                </circle>
              )}
            </g>
          );
        })}

        {/* 入口节点 */}
        {entryNodes.map((e, i) => (
          // 点节点 = 去对应页：入口去站点管理，容器去它的详情页（能看日志）。
          // 拓扑是用来"顺着链路查问题"的，查到哪一段能直接跳过去才有用。
          <Link key={e.key} to="/sites" className="cursor-pointer">
          <g transform={`translate(${ENTRY_X} ${entryY[i] - 15})`} className="hover:opacity-80">
            <rect width="230" height="30" rx="9" className="fill-muted/40 stroke-border" strokeWidth="1" />
            <circle cx="13" cy="15" r="3" className={e.port ? 'fill-sky-500' : 'fill-muted-foreground'} />
            <text x="24" y="13" className="fill-foreground text-[11px] font-medium">
              {e.label.length > 26 ? `${e.label.slice(0, 25)}…` : e.label}
            </text>
            <text x="24" y="24" className="fill-muted-foreground text-[9px]">
              {e.port ? `${t('topology.to_port')} ${e.port}` : e.sub.slice(0, 30)}
            </text>
          </g>
          </Link>
        ))}

        {/* 容器节点 */}
        {containerNodes.map((c, i) => {
          const matched = links.some((l) => l.targetIndex === i);
          return (
            <Link key={c.key} to={`/docker/containers/${c.key}`} className="cursor-pointer">
            <g transform={`translate(${CONTAINER_X} ${containerY[i] - 15})`} className="hover:opacity-80">
              <rect
                width="190"
                height="30"
                rx="9"
                className={cn('stroke-border', matched ? 'fill-emerald-500/8' : 'fill-muted/40')}
                strokeWidth="1"
              />
              <circle cx="13" cy="15" r="3" className={matched ? 'fill-emerald-500' : 'fill-muted-foreground/50'} />
              <text x="24" y="13" className="fill-foreground text-[11px] font-medium">
                {c.label.length > 20 ? `${c.label.slice(0, 19)}…` : c.label}
              </text>
              <text x="24" y="24" className="fill-muted-foreground text-[9px]">
                {c.sub}
              </text>
            </g>
            </Link>
          );
        })}
      </svg>

      {entryNodes.length === 0 && (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('topology.empty')}</p>
      )}
    </div>
  );
}
