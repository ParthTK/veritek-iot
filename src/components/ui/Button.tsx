import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/utils/cn';

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'success';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-300',
  secondary: 'bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:text-gray-400',
  outline: 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:text-gray-400',
  ghost: 'text-gray-600 hover:bg-gray-100 hover:text-gray-800',
  danger: 'bg-error-600 text-white hover:bg-error-700 disabled:bg-error-300',
  success: 'bg-success-600 text-white hover:bg-success-700 disabled:bg-success-300',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-2.5 text-theme-xs gap-1.5',
  md: 'h-9 px-3.5 text-theme-sm gap-2',
  lg: 'h-11 px-4 text-theme-sm gap-2',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  fullWidth = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-medium transition-colors disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="animate-spin" size={16} aria-hidden /> : null}
      {children}
    </button>
  );
}
