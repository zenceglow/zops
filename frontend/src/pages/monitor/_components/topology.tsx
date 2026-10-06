import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { ContainerInfo } from '../_api';
import type { SiteEntry } from '../../sites/_api';
import { summarizeSite } from '../../sites/_lib/site-summary';
import { cn } from '../../../lib/utils';

const W = 1000;
const GLOBE = { x: 108, r: 64 };
const ENTRY_X = 400;
const CONTAINER_X = 790;
/** 一行节点占的高度（节点盒 30 + 间隙）。画布高度按行数算，不再写死。 */
const ROW = 46;
const PAD_Y = 44;

type Node = { key: string; label: string; sub: string };

/** 右边那一列里除了容器，还可能是"本机进程"或"外部服务"。 */
type RightNode = Node & {
  kind: 'container' | 'host' | 'external';
  /** 容器节点能点进详情页。 */
  to?: string;
};

/**
 * 把 Caddy 里的上游地址拆成 host + port。
 *
 * `localhost:9082`、`api:8080`、`[::1]:80`、`example.com:443`、`unix//run/x.sock`
 * 都可能出现。认不出来的原样留着，下面按"外部"处理 —— 宁可标成外部，
 * 也不能假装它连到了某个容器上。
 */
function parseTarget(raw: string): { host: string; port: string | null; label: string } {
  const value = raw.trim().replace(/^https?:\/\//i, '').split('/')[0];
  const m =
    value.match(/^\[([^\]]+)\](?::(\d+))?$/) ?? value.match(/^([^:]+?)(?::(\d+))?$/);
  const host = m?.[1] ?? value;
  const port = m?.[2] ?? null;
  return { host, port, label: port ? `${host}:${port}` : host };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

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

  // —— 数据：入口 → 它代理的每一个目标 → 容器 / 本机进程 / 外部服务 ——
  // 不再截前 N 个。以前 `slice(0, 6)`：站点一多，第 7 个之后的链路**整条消失**，
  // 而且看起来"图是完整的" —— 那是这张图最不该犯的错。现在有几个画几个，
  // 画布高度按行数算，装不下就让卡片自己滚。
  const entryNodes: (Node & { targets: string[]; url: string | null })[] = entries.map(
    (s) => {
      const info = summarizeSite(s);
      return {
        key: s.addr,
        label: s.addr,
        sub: info.target || t('sites.kind_other'),
        targets: info.targets,
        url: info.url,
      };
    },
  );

  // 端口 → 容器、容器名 → 容器，两张表用来把上游地址翻译成节点。
  //
  // 表建在**全部**容器上，而不是"准备画的那些"。以前先 `slice(0, 6)` 再拿截过的
  // 表去匹配：这台机器上跑着 8 个容器时，第 7、8 个明明在跑，却因为"表里没有"
  // 被画成外部服务 —— 这张图是拿来顺着排 502 的，标错比不画还糟。
  const byPort = new Map<string, number>();
  const byName = new Map<string, number>();
  containers.forEach((c, i) => {
    const port = c.ports.match(/:(\d+)-\d+/)?.[1];
    if (port) byPort.set(port, i);
    byName.set(c.name, i);
  });

  const containerNodeOf = (c: ContainerInfo): RightNode => {
    const host = c.ports.match(/:(\d+)-\d+/)?.[1] ?? null;
    const stopped = c.state !== 'running';
    return {
      key: c.id,
      // 用容器名而不是镜像名：Caddyfile 里写的就是名字（`paober-web:80`），
      // 两边对得上，图上才能一眼认出是哪一条链路。
      label: c.name || c.image,
      sub: host ? `: ${host}` : stopped ? t('topology.stopped') : c.image,
      kind: 'container',
      to: `/docker/containers/${c.id}`,
    };
  };

  /**
   * 一个上游地址落在哪儿。
   *
   * 三种结果，缺一种这张图就会骗人：
   * - 找到同端口的容器（或名字对得上的容器）→ 容器节点；
   * - `localhost:4000` 但没容器发布 4000 → **本机进程**（后端跑在 systemd 里
   *   很常见），不画的话这条链路看起来是断的；
   * - 域名 / 非回环 IP → **外部服务**，请求出了这台机器，图上就该有个出口。
   */
  const extras: RightNode[] = [];
  type RawEdge = {
    entryIndex: number;
    kind: RightNode['kind'];
    /** 命中的容器在 containers 里的下标。 */
    containerIndex?: number;
    /** 落在 extras 里的下标。 */
    extraIndex?: number;
    key: string;
  };

  // 第一遍：每条出边先解析成"哪个容器"或"哪个额外节点"，先不算坐标 ——
  // 右边该画哪几个容器，得等所有边都看过才知道。
  const rawEdges: RawEdge[] = [];
  entryNodes.forEach((e, ei) => {
    e.targets.forEach((raw) => {
      const { host, port, label } = parseTarget(raw);
      const ci = (port ? byPort.get(port) : undefined) ?? byName.get(host);
      if (ci !== undefined) {
        rawEdges.push({
          entryIndex: ei,
          kind: 'container',
          containerIndex: ci,
          key: `${e.key}->${raw}`,
        });
        return;
      }
      const isLoopback = LOOPBACK.has(host);
      const key = `${isLoopback ? 'host' : 'ext'}:${label}`;
      let xi = extras.findIndex((n) => n.key === key);
      if (xi < 0) {
        extras.push({
          key,
          label,
          sub: isLoopback ? t('topology.host_process') : t('topology.external'),
          kind: isLoopback ? 'host' : 'external',
        });
        xi = extras.length - 1;
      }
      rawEdges.push({
        entryIndex: ei,
        kind: isLoopback ? 'host' : 'external',
        extraIndex: xi < 0 ? undefined : xi,
        key: `${e.key}->${raw}`,
      });
    });
  });

  // 第二遍：只画真正被引用到的容器（按容器列表顺序），再接上额外节点。
  const usedIdx: number[] = [];
  rawEdges.forEach((e) => {
    if (e.containerIndex !== undefined && !usedIdx.includes(e.containerIndex)) {
      usedIdx.push(e.containerIndex);
    }
  });
  usedIdx.sort((a, b) => a - b);
  const containerNodes: RightNode[] = usedIdx.map((i) => containerNodeOf(containers[i]));
  const slotOf = new Map(usedIdx.map((ci, ni) => [ci, ni]));
  const edges = rawEdges.map((e) => ({
    entryIndex: e.entryIndex,
    kind: e.kind,
    nodeIndex:
      e.containerIndex !== undefined
        ? (slotOf.get(e.containerIndex) ?? -1)
        : e.extraIndex !== undefined
          ? containerNodes.length + e.extraIndex
          : -1,
    key: e.key,
  }));

  const rightNodes: RightNode[] = [...containerNodes, ...extras];

  // 画布高度按"最多的那一列"算，节点之间至少留 ROW。
  const rows = Math.max(entryNodes.length, rightNodes.length, 1);
  const H = Math.max(320, PAD_Y * 2 + (rows - 1) * ROW);
  const globeY = H / 2;
  const spread = (count: number) => {
    if (count <= 0) return [];
    if (count === 1) return [H / 2];
    const usable = H - PAD_Y * 2;
    const step = Math.max(ROW, usable / (count - 1));
    const total = step * (count - 1);
    const start = (H - total) / 2;
    return Array.from({ length: count }, (_, i) => start + step * i);
  };
  const entryY = spread(entryNodes.length);
  const containerY = spread(rightNodes.length);

  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = (x2 - x1) * 0.45;
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  };

  return (
    <div className="rounded-2xl border border-border/60 px-4 py-4">
      {/* 图高按内容走；节点太多就自己滚，不把整页撑长，也不裁掉任何一条链路。 */}
      <div className="max-h-[70vh] overflow-y-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ minHeight: 300 }}
        role="img"
        aria-label={t('topology.title')}
      >
        <defs>
          <radialGradient id="globe-fill" cx="38%" cy="32%">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.06" />
          </radialGradient>
        </defs>

        {/* 地球：一圈本体 + 会呼吸的光晕 + 转动的经络 */}
        <g className="text-sky-500">
          <circle cx={GLOBE.x} cy={globeY} r={GLOBE.r + 10} className="fill-sky-500/5 animate-breathe" />
          <circle cx={GLOBE.x} cy={globeY} r={GLOBE.r} fill="url(#globe-fill)" className="stroke-sky-500/40" />
          {[0.9, 0.6, 0.28].map((k, i) => (
            <ellipse
              key={k}
              cx={GLOBE.x}
              cy={globeY}
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
              y1={globeY + GLOBE.r * k}
              x2={GLOBE.x + GLOBE.r * Math.sqrt(1 - k * k)}
              y2={globeY + GLOBE.r * k}
              className="stroke-sky-500/35"
              strokeWidth="1"
            />
          ))}
        </g>

        {/* 地球 → 入口 */}
        {entryNodes.map((e, i) => {
          const d = curve(GLOBE.x + GLOBE.r - 6, globeY, ENTRY_X - 6, entryY[i]);
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

        {/* 入口 → 后端。按目标的性质分色：容器绿、本机进程天蓝、外部琥珀。 */}
        {edges.map((edge, i) => {
          if (edge.nodeIndex < 0) return null;
          const d = curve(ENTRY_X + 6, entryY[edge.entryIndex], CONTAINER_X - 6, containerY[edge.nodeIndex]);
          const stroke =
            edge.kind === 'container'
              ? 'stroke-emerald-500/45'
              : edge.kind === 'host'
                ? 'stroke-sky-500/45'
                : 'stroke-amber-500/50';
          const dot =
            edge.kind === 'container' ? 'fill-emerald-400' : edge.kind === 'host' ? 'fill-sky-400' : 'fill-amber-400';
          return (
            <g key={edge.key}>
              <path d={d} className={`topology-edge fill-none ${stroke}`} strokeWidth="1.2" />
              {!reducedMotion && (
                <circle r="2.4" className={dot}>
                  <animateMotion dur={`${3 + i * 0.35}s`} repeatCount="indefinite" path={d} />
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
            <circle
              cx="13"
              cy="15"
              r="3"
              className={e.targets.length > 0 ? 'fill-sky-500' : 'fill-muted-foreground'}
            />
            <text x="24" y="13" className="fill-foreground text-[11px] font-medium">
              {e.label.length > 26 ? `${e.label.slice(0, 25)}…` : e.label}
            </text>
            <text x="24" y="24" className="fill-muted-foreground text-[9px]">
              {/* 一个入口分流到几个后端时，把端口都列出来（最多两个），
                  多到列不下就报个数 —— 比只写第一个诚实。 */}
              {e.targets.length === 0
                ? e.sub.slice(0, 30)
                : e.targets.length === 1
                  ? `${t('topology.to_port')} ${e.targets[0]}`
                  : e.targets.length <= 2
                    ? `${t('topology.to_port')} ${e.targets.join(' / ')}`
                    : t('topology.backends', { count: e.targets.length })}
            </text>
          </g>
          </Link>
        ))}

        {/* 右列：容器 + 本机进程 + 外部服务 */}
        {rightNodes.map((node, i) => {
          const matched = edges.some((e) => e.nodeIndex === i);
          const body = (
            <g transform={`translate(${CONTAINER_X} ${containerY[i] - 15})`} className="hover:opacity-80">
              <rect
                width="190"
                height="30"
                rx="9"
                // 非容器节点画虚线：一眼能分出"这一跳不在这台机器的容器里"。
                strokeDasharray={node.kind === 'container' ? undefined : '4 3'}
                className={cn(
                  'stroke-border',
                  node.kind === 'container'
                    ? matched
                      ? 'fill-emerald-500/8'
                      : 'fill-muted/40'
                    : matched
                      ? node.kind === 'host'
                        ? 'fill-sky-500/8'
                        : 'fill-amber-500/8'
                      : 'fill-muted/30',
                )}
                strokeWidth="1"
              />
              <circle
                cx="13"
                cy="15"
                r="3"
                className={cn(
                  node.kind === 'container'
                    ? matched
                      ? 'fill-emerald-500'
                      : 'fill-muted-foreground/50'
                    : node.kind === 'host'
                      ? 'fill-sky-500'
                      : 'fill-amber-500',
                )}
              />
              <text x="24" y="13" className="fill-foreground text-[11px] font-medium">
                {node.label.length > 20 ? `${node.label.slice(0, 19)}…` : node.label}
              </text>
              <text x="24" y="24" className="fill-muted-foreground text-[9px]">
                {node.sub}
              </text>
            </g>
          );
          return node.to ? (
            <Link key={node.key} to={node.to} className="cursor-pointer">
              {body}
            </Link>
          ) : (
            <g key={node.key}>{body}</g>
          );
        })}
      </svg>
      </div>

      {/* 空状态不能只是一句话：告诉用户"还没有"却不告诉他去哪儿加，等于把死路摆出来。 */}
      {entryNodes.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-10">
          <p className="text-sm text-muted-foreground">{t('topology.empty')}</p>
          <Link
            to="/sites"
            className="group inline-flex items-center gap-1.5 rounded-xl border border-border/70 px-3.5 py-2 text-sm text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          >
            {t('topology.go_configure')}
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      )}
    </div>
  );
}
