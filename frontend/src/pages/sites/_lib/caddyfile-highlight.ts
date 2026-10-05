export type Token = { text: string; cls: string };

/**
 * Caddyfile 分词，够高亮用就行。
 *
 * 没上 CodeMirror / Monaco：这里要的只是"看得清结构"，而 Caddyfile 的语法规则
 * 少到能数得过来 —— 注释、引号字符串、占位符（{remote_host}）、命名匹配器
 * （@apiPaths）、块花括号，加上"行首那个词是站点地址还是指令"。
 * 为了这点东西拉进来一个几百 KB 的编辑器（还得自带主题适配）不划算。
 */

const CLASS = {
  comment: 'text-muted-foreground/70 italic',
  string: 'text-emerald-600 dark:text-emerald-400',
  placeholder: 'text-violet-600 dark:text-violet-400',
  matcher: 'text-amber-600 dark:text-amber-400',
  directive: 'text-sky-700 dark:text-sky-400',
  address: 'text-foreground font-semibold',
  brace: 'text-muted-foreground',
  plain: '',
} as const;

/** 一次扫一行：空白 / 注释 / 字符串 / 占位符 / 匹配器 / 花括号 / 词。 */
const TOKEN_RE =
  /(\s+)|(#[^\n]*)|("(?:[^"\\]|\\.)*")|(\{[A-Za-z0-9_.-]*\})|(@[A-Za-z0-9_-]+)|([{}])|([^\s{}"#]+)/g;

export function highlightCaddyfile(src: string): Token[] {
  const out: Token[] = [];
  // depth 用来区分"顶层的站点地址"和"块里的指令"：两者都是行首第一个词。
  let depth = 0;
  const lines = src.split('\n');

  lines.forEach((line, lineIndex) => {
    let seenWord = false;
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = TOKEN_RE.exec(line)) !== null) {
      const [text, space, comment, str, placeholder, matcher, brace, word] = m;
      if (space) {
        out.push({ text, cls: CLASS.plain });
      } else if (comment) {
        out.push({ text, cls: CLASS.comment });
      } else if (str) {
        out.push({ text, cls: CLASS.string });
      } else if (placeholder) {
        out.push({ text, cls: CLASS.placeholder });
      } else if (matcher) {
        out.push({ text, cls: CLASS.matcher });
        seenWord = true;
      } else if (brace) {
        out.push({ text, cls: CLASS.brace });
        depth += brace === '{' ? 1 : -1;
        if (depth < 0) depth = 0;
      } else if (word) {
        // 行首那个词要么是站点地址（顶层），要么是指令（块内）；其余都是参数。
        const cls = !seenWord ? (depth === 0 ? CLASS.address : CLASS.directive) : CLASS.plain;
        out.push({ text, cls });
        seenWord = true;
      }
    }

    // 换行单独作为一个 token 推到流里，而不是每行一个块级元素 —— 否则空行会塌成
    // 零高度，和 textarea 的行高对不上。
    if (lineIndex < lines.length - 1) out.push({ text: '\n', cls: CLASS.plain });
  });

  return out;
}
