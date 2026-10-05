import type { Directive, SiteEntry } from '../_api';
import { siteUrl } from '../../../lib/site-url';

export type SiteFeature = 'header' | 'encode' | 'log' | 'tls' | 'blocked' | 'route';

export type SiteSummary = {
  /** 这个入口把请求交给谁：反代到某个上游，或者直接发静态文件。 */
  kind: 'proxy' | 'static' | 'other';
  target: string;
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

export function summarizeSite(site: SiteEntry): SiteSummary {
  const keys = new Set<string>();
  collectKeys(site.directives, keys);

  const proxy = findDirective(site.directives, 'reverse_proxy');
  const root = findDirective(site.directives, 'root');
  const isStatic = !!root && keys.has('file_server');

  let kind: SiteSummary['kind'] = 'other';
  let target = '';
  if (proxy) {
    kind = 'proxy';
    // `reverse_proxy localhost:8081 { ... }` —— 目标就是第一个参数。
    target = proxy.args[0] ?? '';
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

  return { kind, target, features, url: siteUrl(site.addr) };
}
