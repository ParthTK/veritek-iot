import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn('card', className)}>{children}</section>;
}

interface CardHeaderProps {
  /** Small leading glyph, matching the icon-before-title pattern in the reference. */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function CardHeader({ icon, title, description, actions, className }: CardHeaderProps) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-3 px-4 py-3', className)}>
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-theme-sm font-semibold text-gray-800">
          {icon}
          <span className="truncate">{title}</span>
        </h2>
        {description ? (
          <p className="mt-0.5 text-theme-xs text-gray-500">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('px-4 pb-4', className)}>{children}</div>;
}

export function CardFooter({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <footer className={cn('flex items-center justify-between gap-3 border-t border-gray-200 px-4 py-2.5', className)}>
      {children}
    </footer>
  );
}
