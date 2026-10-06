import { cn } from '../lib/utils';

/**
 * ZOPS 字标 —— 品牌就是这四个大写字母，没有图形 logo。
 *
 * 以前这里套的是公司 logo（两个交叠的圆）的副本，而公司 logo 会频繁改版：
 * 每改一次，面板这边就得跟着对齐一遍，忘了就是"面板还挂着旧 logo"。面板是
 * 独立产品，不该跟着公司 VI 走，所以统一收成字标。
 *
 * 尺寸由调用方给：传 `text-4xl`、`text-6xl` 这种字号类名，不要给 size-*。
 */
export function BrandLogo({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center leading-none font-black tracking-[-0.045em] select-none',
        className,
      )}
    >
      ZOPS
    </span>
  );
}
