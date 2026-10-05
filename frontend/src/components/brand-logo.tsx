import { cn } from '../lib/utils';

/**
 * 主站 logo（两个交叠的圆）套在本面板的 app-icon 底板里：
 * 24% 圆角 + TL→BR 白–黑–白渐变描边，和主站顶栏的呈现保持一致。
 *
 * 圆的几何值直接取自 zenceglow-web/public/logo.svg，改主站 logo 时这里要对齐。
 */
export function BrandLogo({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[24%] p-px',
        className,
      )}
      style={{
        backgroundImage:
          'linear-gradient(to bottom right, #ffffff,rgba(0, 0, 0, 0.85), #ffffff)',
      }}
      aria-hidden
    >
      <span className="flex size-full items-center justify-center overflow-hidden rounded-[24%] bg-neutral-950 text-white">
        <svg
          viewBox="0 0 1024 1024"
          xmlns="http://www.w3.org/2000/svg"
          className="block size-full"
        >
          <ellipse cx="397.241" cy="511.5" rx="205.735" ry="207.9" fill="#B8B8B8" />
          <ellipse cx="625.814" cy="511.5" rx="205.735" ry="207.9" fill="#FFFFFF" />
        </svg>
      </span>
    </span>
  );
}
