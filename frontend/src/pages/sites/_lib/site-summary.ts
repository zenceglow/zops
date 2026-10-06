import type { Directive, SiteEntry } from '../_api';
import { siteUrl } from '../../../lib/site-url';

export type SiteFeature = 'header' | 'encode' | 'log' | 'tls' | 'blocked' | 'route';

export type SiteSummary = {
  /** 这个入口把请求交给谁：反代到某个上游，或者直接发静态文件。 */
  kind: 'proxy' | 'static' | 'other';
  /** 第一个目标。列表页那一行只写得下一个，用它。 */
  target: string;
  /**
   * **全部**代理目标。
   *
   * 一个站点可以按路径分流到好几个后端（`handle_path /api/* { reverse_proxy api:8080 }`
   * 和 `reverse_proxy web:80` 并存），只看第一个就把半个链路丢了。
   */
  targets: string[];
  /** 站点开了哪些"能力"，用来看它是不是按规范配的。 */
  features: SiteFeature[];
  url: string | null;
};

/**
 * 把站点块归纳成"人话"。
 *
 * 之前这一屏直接把指令树摊开：header / encode / handle / respond @blockedPaths 403……
 * 对写 Caddyfile 的人有用，对"我就想知道这个域名指向哪儿"的人就是一堵墙。
 * 这里只回答三件事：这是什么、指向哪、开了哪些能力。想看细节的可以展开。
 */
/**
 * 深度优先找某个指令。
 *
 * 不能只看顶层：现网里 `api.yueqixing.com` 是 `route { @apiPaths … handle { reverse_proxy … } }`，
 * 只看顶层会把它归成"其他配置"，而它明明是个反向代理。
 */
function findDirective(list: Directive[], key: string): Directive | undefined {
  for (const d of list) {
    if (d.key === key) return d;
    const nested = findDirective(d.sub, key);
    if (nested) return nested;
  }
  return undefined;
}

function collectKeys(list: Directive[], into: Set<string>) {
  for (const d of list) {
    into.add(d.key);
    collectKeys(d.sub, into);
  }
}

/**
 * 递归收集所有 `reverse_proxy` 的上游，按出现顺序去重。
 *
 * 两种"一对多"都要收全：
 * - 一个站点按路径分流到多个后端（`handle` / `route` 里各写一个 reverse_proxy）；
 * - 一个 reverse_proxy 自己挂多个上游做负载均衡（`reverse_proxy a:8080 b:8080`）——
 *   以前只取 `args[0]`，另一半上游在链路图上是断的。
 *
 * 参数里的匹配器（`*`、`@name`、`/path/*`）不是上游，跳过。
 */
function collectProxies(list: Directive[], into: string[]) {
  for (const d of list) {
    if (d.key === 'reverse_proxy') {
      for (const arg of d.args) {
        const isMatcher = arg === '*' || arg.startsWith('@') || arg.startsWith('/');
        if (!isMatcher && !into.includes(arg)) into.push(arg);
      }
    }
    collectProxies(d.sub, into);
  }
}

export function summarizeSite(site: SiteEntry): SiteSummary {
  const keys = new Set<string>();
  collectKeys(site.directives, keys);

  const proxy = findDirective(site.directives, 'reverse_proxy');
  const root = findDirective(site.directives, 'root');
  const isStatic = !!root && keys.has('file_server');

  let kind: SiteSummary['kind'] = 'other';
  let target = '';
  const targets: string[] = [];
  if (proxy) {
    kind = 'proxy';
    collectProxies(site.directives, targets);
    // 列表页那一行只写得下一个，用它。注意不能直接用 args[0]：
    // `reverse_proxy * localhost:3000` 的第一个参数是匹配器，不是目标。
    target = targets[0] ?? '';
  } else if (isStatic) {
    kind = 'static';
    // `root * /var/www` —— 第一个参数是匹配符，路径在第二个。
    target = root?.args.filter((a) => a !== '*').join(' ') ?? '';
  }

  const features: SiteFeature[] = [];
  if (keys.has('header')) features.push('header');
  if (keys.has('encode')) features.push('encode');
  if (keys.has('log')) features.push('log');
  if (keys.has('tls')) features.push('tls');
  if (keys.has('route')) features.push('route');
  // 拦截扫描器路径：`respond @blockedPaths 403` —— 带匹配器参数、且是 4xx 的 respond。
  // 同样要递归找：有的站点把它写在 route { ... } 里。
  const blocked = (function scan(list: Directive[]): boolean {
    return list.some(
      (d) =>
        (d.key === 'respond' &&
          d.args.some((a) => a.startsWith('@')) &&
          /^4\d\d$/.test(d.args[d.args.length - 1] ?? '')) ||
        scan(d.sub),
    );
  })(site.directives);
  if (blocked) features.push('blocked');

  return { kind, target, targets, features, url: siteUrl(site.addr) };
}
