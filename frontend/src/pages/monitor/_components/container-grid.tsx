import { useEffect, useState, type ComponentType, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Database, Globe, Package, Server, Terminal } from 'lucide-react';
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

/** 品牌图标 + 品牌色。没有品牌色的（兜底形状图标）跟着主题走。 */
type Brand = { icon: Glyph; color?: string };

const ICON_RULES: [RegExp, Brand][] = [
  [/mariadb/i, { icon: SiMariadb, color: '#003545' }],
  [/mysql/i, { icon: SiMysql, color: '#4479A1' }],
  [/postgres|pgsql/i, { icon: SiPostgresql, color: '#4169E1' }],
  [/mongo/i, { icon: SiMongodb, color: '#47A248' }],
  [/redis/i, { icon: SiRedis, color: '#FF4438' }],
  [/clickhouse/i, { icon: SiClickhouse, color: '#FFCC01' }],
  [/influx/i, { icon: SiInfluxdb, color: '#22ADF6' }],
  [/elastic|opensearch/i, { icon: SiElasticsearch, color: '#005571' }],
  [/rabbitmq/i, { icon: SiRabbitmq, color: '#FF6600' }],
  [/minio/i, { icon: SiMinio, color: '#C72C48' }],
  [/supabase/i, { icon: SiSupabase, color: '#3FCF8E' }],
  [/grafana/i, { icon: SiGrafana, color: '#F46800' }],
  [/prometheus/i, { icon: SiPrometheus, color: '#E6522C' }],
  [/jenkins/i, { icon: SiJenkins, color: '#D24939' }],
  [/gitea|forgejo/i, { icon: SiGitea, color: '#609926' }],
  [/nextcloud/i, { icon: SiNextcloud, color: '#0082C9' }],
  [/ghost/i, { icon: SiGhost, color: '#15171A' }],
  [/home-?assistant/i, { icon: SiHomeassistant, color: '#18BCF2' }],
  [/vault/i, { icon: SiVault, color: '#FFEC6E' }],
  [/portainer/i, { icon: SiPortainer, color: '#13BEF9' }],
  [/traefik/i, { icon: SiTraefikproxy, color: '#24A1C1' }],
  [/caddy/i, { icon: SiCaddy, color: '#1F88C0' }],
  [/nginx/i, { icon: SiNginx, color: '#009639' }],
  [/node|bun|deno|next\.?js|vite/i, { icon: SiNodedotjs, color: '#5FA04E' }],
  [/python|django|flask|uvicorn|gunicorn|celery/i, { icon: SiPython, color: '#3776AB' }],
  [/registry|docker/i, { icon: SiDocker, color: '#2496ED' }],
  // 兜底：至少区分出"数据库 / 站点 / 任务"这几类形状。这些没有品牌色，
  // 底色跟着主题走（也就是现在的反色块）。
  [/data|database|\bdb\b|sql/i, { icon: Database }],
  [/web|http|proxy|gateway/i, { icon: Globe }],
  [/ssh|git|runner|agent|worker|job|ci\b/i, { icon: Terminal }],
];

function brandFor(c: ContainerInfo): Brand {
  // 镜像名在前：名字是用户自己起的（"myserver-1"），镜像才是这个容器到底跑了什么。
  const hay = `${c.image} ${c.name}`;
  for (const [re, brand] of ICON_RULES) {
    if (re.test(hay)) return brand;
  }
  return { icon: Package };
}

/**
 * 底色上该配深色字还是浅色字。
 *
 * 品牌色里既有 #003545 这种近黑的，也有 #FFCC01 这种亮黄，写死"白字"必然有一半
 * 看不清，所以按相对亮度算 —— 用的是 WCAG 那套线性化，不是简单取平均。
 */
function readableOn(hex: string): 'light' | 'dark' {
  const [r, g, b] = hex
    .replace('#', '')
    .match(/../g)!
    .map((h) => parseInt(h, 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const l = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return l > 0.5 ? 'dark' : 'light';
}

/**
 * 端口映射，写成 `宿主→容器`。
 *
 * 后端已经把 Docker 的 `0.0.0.0:80->80/tcp, [::]:80->80/tcp` 归一成
 * `0.0.0.0:80-80, [::]:80-80`，冒号后是宿主端口、横杠后是容器端口；v4/v6 两条
 * 记录指向同一个映射，用 Set 去重。`public_port = 0` 表示"只声明、没映射到宿主"
 * （mysql 那种 33060-33061/tcp），跳过。
 *
 * 之前这里只显示宿主端口、还带个前导冒号（": 3307"），被读成"不对外映射"这种
 * 莫名其妙的符号。写成箭头既说明了方向，也省掉猜。两端相同时只留一个数 —— 那时
 * 本来就没有"哪个是哪个"的歧义。
 *
 * 没有任何映射就返回空串，让调用方整行不渲染。
 */
function shortPorts(ports: string): string {
  const pairs = new Map<string, string>();
  for (const part of ports.split(',')) {
    const m = part.match(/:(\d+)-(\d+)/);
    if (!m) continue;
    const [, host, container] = m;
    if (host === '0') continue;
    pairs.set(host, container);
  }
  return Array.from(pairs)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([host, container]) => (host === container ? host : `${host}→${container}`))
    .join(' ');
}

/**
 * 把 Docker 的 RFC3339 时间解析成 Date。
 *
 * 纳秒精度（…401113303Z）是重点：JS 的 Date 只认到毫秒，多出来的位数在部分
 * 引擎上会让解析失败，所以先裁到毫秒。已停止且从未启动过的容器会拿到
 * 0001-01-01 这个零值，这里返回 null，调用方按"未知"处理而不是显示公元 1 年。
 */
function parseDockerTime(iso: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso.replace(/(\.\d{3})\d+/, '$1'));
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 1970) return null;
  return d;
}

/** 具体时刻，只用在 tooltip 里当兜底信息。 */
function formatExact(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const year = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}-`;
  return `${year}${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 相对时间：卡片上一律说"多久之前"。
 *
 * 绝对时刻（10-06 02:41）得先在脑子里做减法才知道是新的还是旧的；"5 天前"是
 * 结论，扫一眼就有判断。文案走 i18n，中英各一套，别在代码里拼字符串。
 */
function useAgoLabel(now: number) {
  const { t } = useTranslation();
  return (d: Date | null) => {
    if (!d) return '';
    const secs = Math.max(0, Math.floor((now - d.getTime()) / 1000));
    if (secs < 60) return t('ago.just_now');
    const mins = Math.floor(secs / 60);
    if (mins < 60) return t('ago.minutes', { count: mins });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t('ago.hours', { count: hours });
    return t('ago.days', { count: Math.floor(hours / 24) });
  };
}

/**
 * 相对时间得自己会走。
 *
 * 这一页只在挂载时取一次数据，没有轮询，所以"3 分钟前"会一直停在 3 分钟，直到
 * 用戶切走再切回来。给一个低频 tick 让它自己重算，页面上又不会为了秒级精度白
 * 重渲染。
 */
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** CPU 百分比：个位数时留一位小数，否则整数就够读了。 */
function formatCpu(pct: number): string {
  return (pct >= 10 ? Math.round(pct) : pct.toFixed(1)) + '%';
}

/**
 * 内存用紧凑单位（209M / 1.2G）。
 *
 * 通用的 formatBytes 会给"209.0 MB"，在这一列窄字里既占宽度又没多给精度。
 */
function compactBytes(b: number): string {
  if (b >= 1 << 30) return (b / (1 << 30)).toFixed(1) + 'G';
  if (b >= 1 << 20) return Math.round(b / (1 << 20)) + 'M';
  return Math.round(b / 1024) + 'K';
}

function ContainerTile({ c, now }: { c: ContainerInfo; now: number }) {
  const { t } = useTranslation();
  const { icon: Icon, color } = brandFor(c);
  const running = c.state === 'running';
  const ports = shortPorts(c.ports);
  const startedAt = parseDockerTime(c.started_at);
  const ago = useAgoLabel(now);

  // 品牌色只在浅色主题下铺底：深色主题保留"白底黑图标"那套反色，全饱和的品牌色
  // 压在暗背景上会跟旁边几个环抢注意力。兜底图标没有品牌色，退回反色。
  const brandStyle = {
    '--brand': color ?? 'var(--foreground)',
    '--brand-fg': color ? (readableOn(color) === 'dark' ? '#111' : '#fff') : 'var(--background)',
  } as CSSProperties;

  return (
    // 横过来的卡片：图标在左、信息在右。之前是竖排的窄格子，五行小字叠在一个
    // 128px 宽的列里，既挤又跟右边的空白对不上。容器名太长（zenceglow-trend-mysql
    // 这种）排面上不显示，收进 tooltip。
    <Link
      to={`/docker/containers/${c.id}`}
      // p-2 + -m-2：悬停底色往四周多出 8px，不然色块紧贴着图标和文字，像是
      // "框住了内容"而不是"托住了这一项"。负边距把多出来的部分抵回去，栅格
      // 间距不变（行距 24px，两侧各 8px 还剩 8px）。
      className="group/tile -m-2 flex min-w-0 items-center gap-3.5 rounded-2xl p-2 transition-colors hover:bg-muted/40"
      title={`${c.name}\n${c.image}\n${c.status}${startedAt ? `\n${t('docker.started')}: ${formatExact(startedAt)}` : ''}`}
    >
      {/* 品牌变量挂在最外层：光晕和色块是同级的兄弟节点，变量放在色块上光晕就取
          不到了（CSS 变量只向下继承，不横向继承）。 */}
      <span className="relative shrink-0" style={running ? brandStyle : undefined}>
        {/* 运行中的呼吸光晕：静态图钉看不出死活，慢速涨落一眼就能分出哪些还活着。 */}
        {running && (
          <span
            aria-hidden
            className="absolute inset-0 animate-breathe rounded-2xl blur-[6px]"
            style={{ backgroundColor: 'var(--brand)' }}
          />
        )}
        <span
          className={cn(
            // 浅色主题用品牌色铺底，深色主题回落到反色块 —— 品牌图标本身细节密
            // （mysql 的海豚、redis 的字标），压在 muted 灰底上远看就是一团模糊。
            'relative flex size-14 items-center justify-center rounded-2xl transition-transform duration-150 hover:-translate-y-0.5',
            running
              ? 'bg-[var(--brand)] text-[var(--brand-fg)] dark:bg-foreground dark:text-background'
              : 'bg-muted text-muted-foreground/60',
          )}
        >
          {/* 品牌图标（mysql 的海豚、redis 的字标）细节比线性图标密，给大一号才认得出来。 */}
          <Icon className="size-8" />
        </span>
        <span
          className={cn(
            'absolute -right-0.5 -bottom-0.5 z-10 size-3 rounded-full ring-2 ring-background',
            running ? 'bg-emerald-500' : 'bg-red-500',
          )}
        />
        {/* 绿点外扩一圈：常驻的扩散波是最省事的"在跑"信号，比让图标一直晃要克制。 */}
        {running && (
          <span
            aria-hidden
            className="absolute -right-0.5 -bottom-0.5 z-10 size-3 animate-ping rounded-full bg-emerald-500 [animation-duration:2.4s]"
          />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'truncate font-mono text-sm',
            running ? 'text-foreground' : 'text-muted-foreground/70',
          )}
        >
          {c.image}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {[ago(startedAt), ports && `${t('docker.ports')} ${ports}`]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {running && (
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground/80 tabular-nums">
            {t('monitor.cpu')} {c.cpu_percent === null ? '—' : formatCpu(c.cpu_percent)}
            <span className="mx-1.5 opacity-40">·</span>
            {t('monitor.memory')} {c.mem_used === null ? '—' : compactBytes(c.mem_used)}
          </p>
        )}
      </div>
    </Link>
  );
}

/** 容器网格：有多少个显示多少个，贴着左边排，跟上面的环、标题对齐。 */
export function ContainerGrid({ containers }: { containers: ContainerInfo[] }) {
  const { t } = useTranslation();
  const now = useNow();
  if (containers.length === 0) return null;

  // 还跑着的排前面：这一排的用处是"现在有什么在服务"，停掉的属于历史，压后面。
  // Array.sort 是稳定排序，所以同类之间保持后端给的顺序（按创建时间倒序）。
  const sorted = [...containers].sort(
    (a, b) => Number(b.state === 'running') - Number(a.state === 'running'),
  );

  return (
    <section>
      {/* 和「站点入口」那块对齐：标题右边也放一个去管理的入口，
          免得这一节只有只读的卡片、想动手还得回 Dock 上找。 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SectionTitle icon={Server} title={t('docker.apps_services')} />
        <Link
          to="/deploy"
          className="group ml-auto inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('docker.manage_apps')}
          <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
      {/* 三列：再宽下去，每格里"图标 + 三行字"只占左边一半，右半边空着反而更散。
          ~340px 刚好盛下最长的镜像名加一行占用，容器变多就自然往下续行。 */}
      <div className="mt-6 grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map((c) => (
          <ContainerTile key={c.id} c={c} now={now} />
        ))}
      </div>
    </section>
  );
}
