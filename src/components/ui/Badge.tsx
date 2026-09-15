import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

const TONES: Record<Tone, string> = {
  success: 'bg-success-50 text-success-700 border-success-200',
  warning: 'bg-warning-50 text-warning-700 border-warning-200',
  error: 'bg-error-50 text-error-700 border-error-200',
  info: 'bg-brand-50 text-brand-700 border-brand-200',
  neutral: 'bg-gray-100 text-gray-600 border-gray-200',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-theme-2xs font-medium',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Solid pill used for the ONLINE/OFFLINE marker on device cards. */
export function StatusPill({ status }: { status: 'online' | 'offline' | 'warning' }) {
  const map = {
    online: { label: 'ONLINE', className: 'bg-success-500 text-white' },
    offline: { label: 'OFFLINE', className: 'bg-gray-400 text-white' },
    warning: { label: 'WARNING', className: 'bg-warning-500 text-white' },
  } as const;
  const { label, className } = map[status];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-theme-2xs font-semibold tracking-wide',
        className,
      )}
    >
      {label}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: 'critical' | 'warning' | 'info' }) {
  const tone = severity === 'critical' ? 'error' : severity === 'warning' ? 'warning' : 'info';
  return <Badge tone={tone}>{severity[0].toUpperCase() + severity.slice(1)}</Badge>;
}

export function AlertStatusBadge({ status }: { status: 'active' | 'acknowledged' | 'resolved' }) {
  const map = {
    active: 'error',
    acknowledged: 'warning',
    resolved: 'success',
  } as const;
  return <Badge tone={map[status]}>{status[0].toUpperCase() + status.slice(1)}</Badge>;
}
