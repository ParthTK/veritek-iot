import type { CSSProperties, ReactNode } from 'react';
import { AlertCircle, Inbox } from 'lucide-react';
import { cn } from '@/utils/cn';

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      <div className="mb-3 text-gray-300" aria-hidden>
        {icon ?? <Inbox size={36} strokeWidth={1.5} />}
      </div>
      <h3 className="text-theme-lg font-semibold text-gray-700">{title}</h3>
      {description ? (
        <p className="mt-1 max-w-sm text-theme-xs text-gray-500">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  description,
  action,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 text-error-400" aria-hidden>
        <AlertCircle size={36} strokeWidth={1.5} />
      </div>
      <h3 className="text-theme-lg font-semibold text-gray-700">{title}</h3>
      {description ? <p className="mt-1 text-theme-xs text-gray-500">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return <div className={cn('animate-pulse rounded bg-gray-200', className)} style={style} />;
}

/** Placeholder that reserves the same height as a chart card while loading. */
export function ChartSkeleton({ height = 280 }: { height?: number }) {
  return (
    <div className="px-4 pb-4" style={{ height }}>
      <div className="flex h-full flex-col justify-end gap-2">
        <Skeleton className="h-3 w-32" />
        <div className="flex flex-1 items-end gap-2">
          {[45, 70, 55, 80, 62, 90, 50, 74, 58, 84, 66, 48].map((h, i) => (
            <Skeleton key={i} className="flex-1" style={{ height: `${h}%` }} />
          ))}
        </div>
        <Skeleton className="h-3 w-full" />
      </div>
    </div>
  );
}

export function TableSkeleton({ rows = 8, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="divide-y divide-gray-100">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 py-2.5">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-3 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}
