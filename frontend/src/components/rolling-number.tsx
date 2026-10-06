import { memo } from 'react';
import { cn } from '../lib/utils';

/**
 * 会滚的数字。
 *
 * 数字突然从 1,284 跳到 1,290 时，人眼是抓不住"变了多少"的；滚一下就有了方向感
 * ——这是大屏上最划算的一点动效。做法是每一位一条 0-9 的竖列，靠 translateY 滚到
 * 对应位置，比整串数字重新渲染更像真的在"转"。
 *
 * 千分位用固定的逗号字符，它不滚，只占位。
 */
function Digit({ value, className }: { value: number; className?: string }) {
  return (
    <span
      className={cn(
        'relative inline-block overflow-hidden tabular-nums',
        className,
      )}
      // 宽高跟着字号走，外面换 text-5xl 也不用改这里。
      style={{ width: '0.62em', height: '1em' }}
      aria-hidden
    >
      <span
        className="absolute inset-x-0 top-0 flex flex-col transition-transform duration-500 ease-out"
        // 竖列一共 10 个字高，滚到第 n 个就往上挪 n 个字号。
        style={{ transform: `translateY(${-value * 10}%)` }}
      >
        {Array.from({ length: 10 }).map((_, n) => (
          <span key={n} className="flex h-[1em] items-center justify-center leading-none">
            {n}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * memo 不是可选项：每个数字是十来个 span，大屏上有二十几个这样的数字。父组件
 * 因为别的原因重绘时（比如同屏的另一个数变了），值没变的那些应当原地不动。
 */
export const RollingNumber = memo(function RollingNumber({
  value,
  decimals = 0,
  className,
}: {
  value: number;
  /** 小数位数。带小数的部分同样会滚，只是字号小一号。 */
  decimals?: number;
  className?: string;
}) {
  // 负数在访问量里没有意义，但真发生了也别显示成 "-1" 这种读不懂的东西。
  const [intPart, fracPart] = Math.max(0, value).toFixed(decimals).split('.');
  const intText = Number(intPart).toLocaleString('en-US');

  return (
    <span className={cn('inline-flex items-baseline font-semibold', className)}>
      {/* 给读屏留一份纯文本：逐位的 span 对无障碍工具是天书。 */}
      <span className="sr-only">
        {intText}
        {fracPart ? `.${fracPart}` : ''}
      </span>
      <span className="inline-flex items-baseline" aria-hidden>
        {intText.split('').map((ch, i) =>
          ch === ',' ? (
            <span key={`sep-${i}`} className="opacity-40">
              ,
            </span>
          ) : (
            <Digit key={i} value={Number(ch)} />
          ),
        )}
        {fracPart && (
          <>
            <span className="opacity-40">.</span>
            <span className="inline-flex items-baseline text-[0.6em]">
              {fracPart.split('').map((ch, i) => (
                <Digit key={`f${i}`} value={Number(ch)} />
              ))}
            </span>
          </>
        )}
      </span>
    </span>
  );
});
