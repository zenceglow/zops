import { useMemo, useRef } from 'react';
import { highlightCaddyfile } from '../_lib/caddyfile-highlight';
import { cn } from '../../../lib/utils';

/**
 * 带高亮的 Caddyfile 编辑器。
 *
 * 做法是"透明 textarea 盖在高亮层上"：textarea 负责光标、选区、输入法，底下那层
 * `<pre>` 只画颜色，两层用完全相同的字体、行高、内边距和 tab 宽度，所以对得齐。
 * 比引编辑器库轻，也不用为 Caddyfile 写一套 TextMate 语法。
 */
export function CaddyfileEditor({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const tokens = useMemo(() => highlightCaddyfile(value), [value]);

  // 两层各自滚动会错位，所以只让 textarea 滚，再把偏移量抄给高亮层。
  const syncScroll = () => {
    const ta = taRef.current;
    const pre = preRef.current;
    if (!ta || !pre) return;
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  };

  // 两层的排版属性必须逐字一致，抽出来免得不小心改偏了一个。
  const SHARED = 'px-3 py-2.5 font-mono text-sm leading-6 whitespace-pre [tab-size:4]';

  return (
    <div
      className={cn(
        // 这里必须是确定高度而不是 min-height：里面两层都用 h-full，而百分比高度
        // 在"只有 min-height 的父元素"上算不出结果，textarea 会塌成默认两行，
        // 高亮层却照常铺满，两层就此错位。
        'relative h-[55vh] overflow-hidden rounded-xl border border-input bg-transparent dark:bg-input/30',
        'focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
        className,
      )}
    >
      <pre
        ref={preRef}
        aria-hidden
        className={cn(
          SHARED,
          'pointer-events-none absolute inset-0 m-0 overflow-hidden text-foreground',
        )}
      >
        {tokens.map((t, i) => (
          <span key={i} className={t.cls}>
            {t.text}
          </span>
        ))}
      </pre>
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        spellCheck={false}
        wrap="off"
        className={cn(
          SHARED,
          'relative block h-full w-full resize-none overflow-auto bg-transparent text-transparent caret-foreground outline-none',
        )}
      />
    </div>
  );
}
