import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarClock, ChevronRight } from 'lucide-react';
import { formatClock } from '@/utils/format';

export interface Crumb {
  label: string;
  to?: string;
}

interface PageHeaderProps {
  title: ReactNode;
  /** Leading glyph shown before the title, as on every reference sub-page. */
  icon?: ReactNode;
  /** Renders the circular back affordance to the left of the title. */
  backTo?: string;
  crumbs?: Crumb[];
  actions?: ReactNode;
  /** ISO timestamp rendered as "Last updated: 10:21:32 AM" on the right. */
  lastUpdated?: string;
  description?: string;
}

export function PageHeader({
  title,
  icon,
  backTo,
  crumbs,
  actions,
  lastUpdated,
  description,
}: PageHeaderProps) {
  return (
    <div className="mb-5">
      {crumbs && crumbs.length > 0 ? (
        <nav aria-label="Breadcrumb" className="mb-2">
          <ol className="flex flex-wrap items-center gap-1 text-theme-2xs text-gray-500">
            {crumbs.map((crumb, i) => (
              <li key={`${crumb.label}-${i}`} className="flex items-center gap-1">
                {i > 0 ? <ChevronRight size={11} aria-hidden className="text-gray-300" /> : null}
                {crumb.to ? (
                  <Link to={crumb.to} className="hover:text-brand-600 hover:underline">
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="text-gray-700">{crumb.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {backTo ? (
            <Link
              to={backTo}
              className="rounded-lg p-1 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
              aria-label="Go back"
            >
              <ArrowLeft size={19} aria-hidden />
            </Link>
          ) : null}
          {icon ? <span className="shrink-0 text-brand-600">{icon}</span> : null}
          <div className="min-w-0">
            <h1 className="truncate text-theme-xl font-bold text-gray-900">{title}</h1>
            {description ? (
              <p className="mt-0.5 text-theme-xs text-gray-500">{description}</p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {lastUpdated ? (
            <p className="flex items-center gap-1.5 text-theme-xs text-gray-500">
              <CalendarClock size={14} aria-hidden />
              Last updated: {formatClock(lastUpdated)}
            </p>
          ) : null}
          {actions}
        </div>
      </div>
    </div>
  );
}
