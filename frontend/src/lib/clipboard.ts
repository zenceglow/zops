/**
 * 复制到剪贴板。
 *
 * 不能只用 `navigator.clipboard`：浏览器只在**安全上下文**里给这个 API，而面板
 * 常见的部署方式是 `http://47.99.101.158:5200` —— 走 IP 的 http 不算安全上下文，
 * `navigator.clipboard` 直接是 undefined，点「复制」什么都不会发生，也不报错。
 * 所以留一条 `execCommand('copy')` 的老路，它在 http 下仍然可用。
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 权限被拒或上下文不对，继续往下走老办法。
    }
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    // 不能 display:none —— 那样选不中，execCommand 复制的是空字符串。
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
