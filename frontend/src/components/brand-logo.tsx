import { cn } from '../lib/utils';

/**
 * App-icon style brand mark: white glyph on black plate,
 * 24% corner radius, TL→BR white–black–white gradient border.
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
          viewBox="0 0 302 302"
          xmlns="http://www.w3.org/2000/svg"
          className="block size-[72%]"
        >
          <path
            fill="currentColor"
            d="M229.997572,71.7769736 C229.997572,68.0066901 227.658066,66.6331244 222.979052,67.6562766 L159.434185,147.469052 C137.078898,119.844865 124.689864,104.860428 122.267083,102.515743 C119.844302,100.171058 117.541601,100.171058 115.358982,102.515743 L72.9975723,230.613749 C73.0522855,232.908377 73.4778088,234.33858 74.2741423,234.904358 C75.0704757,235.470135 76.6584174,235.470135 79.0379672,234.904358 L125.513407,179.72321 C146.285098,205.312145 158.327692,219.861442 161.641188,223.371103 C164.954684,226.880763 167.198494,226.880763 168.372618,223.371103 C187.836202,177.082669 200.838195,145.99879 207.378597,130.119464 C222.457914,93.50866 229.997572,74.0611632 229.997572,71.7769736 Z"
          />
        </svg>
      </span>
    </span>
  );
}
