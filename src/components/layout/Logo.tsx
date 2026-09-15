import logoUrl from '@/assets/veritek-logo.png';
import { cn } from '@/utils/cn';

/**
 * Veritek Engineering brand lockup (globe mark + wordmark + sub-line),
 * sourced from the corporate asset at images/LOGO.png (1186×265).
 *
 * The artwork is orange on transparency, so on the blue login panel it is
 * placed on a white chip — the light-blue detail inside the globe mark would
 * otherwise disappear against the brand blue.
 */
export function Logo({
  variant = 'dark',
  height = 30,
  className,
}: {
  variant?: 'dark' | 'light';
  /** Rendered height in px; width follows the 4.475:1 aspect ratio. */
  height?: number;
  className?: string;
}) {
  const img = (
    <img
      src={logoUrl}
      alt="Veritek Engineering Private Limited"
      height={height}
      style={{ height, width: 'auto' }}
      className="block w-auto max-w-full object-contain"
    />
  );

  if (variant === 'light') {
    return (
      <div className={cn('inline-flex rounded-lg bg-white px-3 py-2 shadow-theme-sm', className)}>
        {img}
      </div>
    );
  }

  return <div className={cn('inline-flex items-center', className)}>{img}</div>;
}
