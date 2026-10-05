import type { ComponentType } from 'react';
import { Database, Globe, Package, Server, Terminal } from 'lucide-react';
import {
  SiCaddy,
  SiClickhouse,
  SiDocker,
  SiElasticsearch,
  SiGitea,
  SiGhost,
  SiGrafana,
  SiHomeassistant,
  SiInfluxdb,
  SiJenkins,
  SiMariadb,
  SiMinio,
  SiMongodb,
  SiMysql,
  SiNextcloud,
  SiNginx,
  SiNodedotjs,
  SiPortainer,
  SiPostgresql,
  SiPrometheus,
  SiPython,
  SiRabbitmq,
  SiRedis,
  SiSupabase,
  SiTraefikproxy,
  SiVault,
} from 'react-icons/si';
import { cn } from '../../../lib/utils';
import type { ContainerInfo } from '../_api';
import { SectionTitle } from './section-title';

/**
 * 按镜像/名字猜一个"应用图标"。
 *
 * 后端不提供容器图标，也不值得为此加接口：容器名和镜像名本身就带着足够的
 * 线索（mysql / caddy / node），按关键词归类比统一画一个方块更像桌面。
 *
 * 认得出的产品直接给品牌图标 —— 一排容器全是同一个"数据库"图标等于没给信息，
 * 而 mysql 和 redis 在运维眼里根本是两回事。认不出的才退回按形状归类。
 */
type Glyph = ComponentType<{ className?: string }>;

const ICON_RULES: [RegExp, Glyph][] = [
  [/mariadb/i, SiMariadb],
  [/mysql/i, SiMysql],
  [/postgres|pgsql/i, SiPostgresql],
  [/mongo/i, SiMongodb],
  [/redis/i, SiRedis],
  [/clickhouse/i, SiClickhouse],
  [/influx/i, SiInfluxdb],
  [/elastic|opensearch/i, SiElasticsearch],
  [/rabbitmq/i, SiRabbitmq],
  [/minio/i, SiMinio],
  [/supabase/i, SiSupabase],
  [/grafana/i, SiGrafana],
  [/prometheus/i, SiPrometheus],
  [/jenkins/i, SiJenkins],
  [/gitea|forgejo/i, SiGitea],
  [/nextcloud/i, SiNextcloud],
  [/ghost/i, SiGhost],
  [/home-?assistant/i, SiHomeassistant],
  [/vault/i, SiVault],
  [/portainer/i, SiPortainer],
  [/traefik/i, SiTraefikproxy],
  [/caddy/i, SiCaddy],
  [/nginx/i, SiNginx],
  [/node|bun|deno|next\.?js|vite/i, SiNodedotjs],
  [/python|django|flask|uvicorn|gunicorn|celery/i, SiPython],
  [/registry|docker/i, SiDocker],
  // 兜底：至少区分出"数据库 / 站点 / 任务"这几类形状。
  [/mysql|data|database|\bdb\b|sql/i, Database],
  [/web|http|proxy|gateway/i, Globe],
  [/ssh|git|runner|agent|worker|job|ci\b/i, Terminal],
];

function iconFor(c: ContainerInfo): Glyph {
  // 镜像名在前：名字是用户自己起的（"myserver-1"），镜像才是这个容器到底跑了什么。
  const hay = `${c.image} ${c.name}`;
  for (const [re, Icon] of ICON_RULES) {
    if (re.test(hay)) return Icon;
  }
  return Package;
}

/**
 * 只取宿主端口。
 *
 * 后端已经把 Docker 的 `0.0.0.0:80->80/tcp, [::]:80->80/tcp` 归一成
 * `0.0.0.0:80-80, [::]:80-80`，所以这里只取中间那个宿主端口；v4/v6 两条记录
 * 会归到同一个端口上，用 Set 去重。`public_port = 0` 表示"只声明、没映射到宿主"，
 * 显示成 : 0 只会让人困惑，跳过。
 *
 * 没有可访问端口就返回空串，让调用方整行不渲染 —— 之前这里恒返回 "—"，因为
 * 正则匹配的是 Docker 原始格式，跟后端格式对不上，于是每个容器下面都挂着一行
 * 不知道是什么的横杠。
 */
function shortPorts(ports: string): string {
  const found = new Set<string>();
  for (const part of ports.split(',')) {
    const host = part.match(/:(\d+)-/)?.[1];
    if (host && host !== '0') found.add(host);
  }
  return found.size > 0 ? ': ' + Array.from(found).sort().join(' ') : '';
}

/**
 * 启动时刻。
 *
 * Docker 给的是纳秒精度的 RFC3339，而 JS 的 Date 只认到毫秒 —— 多出来的位数在
 * 部分引擎上会让解析失败，所以先裁到毫秒。已停止且从未启动过的容器会拿到
 * 0001-01-01 这个零值，按"未知"处理而不是显示成公元 1 年。
 */
function formatStarted(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso.replace(/(\.\d{3})\d+/, '$1'));
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 1970) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  const year = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}-`;
  return `${year}${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function ContainerTile({ c }: { c: ContainerInfo }) {
  const Icon = iconFor(c);
  const running = c.state === 'running';
  const ports = shortPorts(c.ports);
  const started = formatStarted(c.started_at);

  return (
    // 容器名太长（zenceglow-trend-mysql 这种），排面上一律不显示，收进 tooltip；
    // 卡片上只留"是什么镜像、映射了什么端口、几点启动的"。
    <div
      className="flex w-[128px] flex-col items-center text-center"
      title={`${c.name}\n${c.image}\n${c.status}`}
    >
      <span className="relative">
        <span
          className={cn(
            // 反色块：深色主题下白底黑图标，浅色主题下黑底白图标。品牌图标本身
            // 细节密（mysql 的海豚、redis 的字标），贴在 muted 灰底上远看就是一团
            // 模糊；反色之后轮廓才立得住，一排容器也像一排应用图标。
            'flex size-12 items-center justify-center rounded-2xl transition-transform duration-150 hover:-translate-y-0.5',
            running ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground/60',
          )}
        >
          {/* 品牌图标（mysql 的海豚、redis 的字标）细节比线性图标密，给大一号才认得出来。 */}
          <Icon className="size-6" />
        </span>
        <span
          className={cn(
            'absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-background',
            running ? 'bg-emerald-500' : 'bg-red-500',
          )}
        />
      </span>
      <span
        className={cn(
          'mt-3 w-full truncate font-mono text-[11px]',
          running ? 'text-foreground/85' : 'text-muted-foreground/60',
        )}
      >
        {c.image}
      </span>
      {ports && (
        <span className="mt-0.5 w-full truncate font-mono text-[11px] text-muted-foreground/70">
          {ports}
        </span>
      )}
      <span
        className={cn(
          'mt-0.5 w-full truncate font-mono text-[11px]',
          running ? 'text-muted-foreground' : 'text-muted-foreground/60',
        )}
      >
        {started || '—'}
      </span>
    </div>
  );
}

/** 容器网格：有多少个显示多少个，贴着左边排，跟上面的环、标题对齐。 */
export function ContainerGrid({ containers }: { containers: ContainerInfo[] }) {
  if (containers.length === 0) return null;
  return (
    <section>
      {/* 不做多语言：用户点名要 "Servers" 这个词，中英环境下都保持原样。 */}
      <SectionTitle icon={Server} title="Servers" />
      <div className="mt-6 flex flex-wrap gap-x-4 gap-y-6">
        {containers.map((c) => (
          <ContainerTile key={c.id} c={c} />
        ))}
      </div>
    </section>
  );
}
