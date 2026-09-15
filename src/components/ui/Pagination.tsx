import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './Button';
import { SelectInput } from './Form';

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
}

/**
 * Matches the reference footer: "‹ Previous — Showing 1-30 of 500 — Next ›",
 * with an optional rows-per-page control for the admin tables.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 30, 50, 100],
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Button
        variant="outline"
        size="sm"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
      >
        <ChevronLeft size={14} aria-hidden />
        Previous
      </Button>

      <div className="flex items-center gap-4">
        <p className="text-theme-xs text-gray-600" aria-live="polite">
          Showing {first}-{last} of {total.toLocaleString('en-IN')}
        </p>
        {onPageSizeChange ? (
          <label className="flex items-center gap-1.5 text-theme-xs text-gray-500">
            <span className="hidden sm:inline">Rows</span>
            <SelectInput
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="h-8 w-[4.5rem] py-0 text-theme-xs"
              aria-label="Rows per page"
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </SelectInput>
          </label>
        ) : null}
      </div>

      <Button
        variant="outline"
        size="sm"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
      >
        Next
        <ChevronRight size={14} aria-hidden />
      </Button>
    </div>
  );
}
