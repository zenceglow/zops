/**
 * Caddy 的站点地址 → 能点的 URL。
 *
 * 地址写法很杂：`flashsync.cn`、`http://localhost:8080`、`:443`、`*.a.com`。
 * 只有前两种浏览器能直接打开；`:443` 是"本机所有网卡的这个端口"，`*.a.com` 是
 * 通配，都没有可访问的主机名，返回 null 让调用方原样当文本显示。
 */
export function siteUrl(addr: string): string | null {
  const head = addr.trim().split(/\s+/)[0];
  if (!head) return null;
  if (/^https?:\/\//i.test(head)) return head;
  if (head.startsWith(':') || head.includes('*')) return null;
  return `https://${head}`;
}
