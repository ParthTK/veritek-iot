import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/utils/cn';
import { EmptyState } from '@/components/ui/States';

export interface Column<T> {
  key: string;
  header: string;
  /** Cell renderer. Falls back to `String(row[key])` when omitted. */
  render?: (row: T) => ReactNode;
  /** Value used for sorting; omit to make the column unsortable. */
  sortValue?: (row: T) => string | number;
  align?: 'left' | 'right' | 'center';
  className?: string;
  headerClassName?: string;
  /** Keeps the column pinned while the table scrolls horizontally. */
  sticky?: boolean;
}

export type SortDirection = 'asc' | 'desc';

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  /** Zebra striping, as used by the reference Meter Data Logs table. */
  striped?: boolean;
  dense?: boolean;
  initialSort?: { key: string; direction: SortDirection };
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyTitle = 'No results found',
  emptyDescription = 'Try adjusting your search or filters.',
  emptyAction,
  striped = true,
  dense = false,
  initialSort,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; direction: SortDirection } | null>(
    initialSort ?? null,
  );

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (!column?.sortValue) return rows;
    const factor = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = column.sortValue!(a);
      const bv = column.sortValue!(b);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor;
      return String(av).localeCompare(String(bv)) * factor;
    });
  }, [rows, sort, columns]);

  function toggleSort(column: Column<T>) {
    if (!column.sortValue) return;
    setSort((prev) => {
      if (!prev || prev.key !== column.key) return { key: column.key, direction: 'asc' };
      if (prev.direction === 'asc') return { key: column.key, direction: 'desc' };
      return null;
    });
  }

  if (rows.length === 0) {
    return (
      <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />
    );
  }

  const cellPad = dense ? 'px-3 py-1.5' : 'px-3 py-2.5';

  return (
    <div className="w-full overflow-x-auto custom-scrollbar">
      <table className="w-full min-w-max border-collapse text-theme-xs">
        <thead>
          <tr className="border-y border-gray-200 bg-gray-50">
            {columns.map((column) => {
              const active = sort?.key === column.key;
              const sortable = Boolean(column.sortValue);
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={
                    active ? (sort!.direction === 'asc' ? 'ascending' : 'descending') : undefined
                  }
                  className={cn(
                    cellPad,
                    'whitespace-nowrap text-left text-theme-2xs font-semibold uppercase tracking-wide text-gray-500',
                    column.align === 'right' && 'text-right',
                    column.align === 'center' && 'text-center',
                    column.sticky && 'sticky left-0 z-10 bg-gray-50',
                    column.headerClassName,
                  )}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(column)}
                      className={cn(
                        'inline-flex items-center gap-1 rounded hover:text-gray-700',
                        column.align === 'right' && 'flex-row-reverse',
                      )}
                    >
                      {column.header}
                      <span aria-hidden className={active ? 'text-brand-600' : 'text-gray-400'}>
                        {!active ? (
                          <ChevronsUpDown size={11} />
                        ) : sort!.direction === 'asc' ? (
                          <ChevronUp size={11} />
                        ) : (
                          <ChevronDown size={11} />
                        )}
                      </span>
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, index) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                'border-b border-gray-100',
                striped && index % 2 === 1 && 'bg-gray-25',
                onRowClick && 'cursor-pointer hover:bg-brand-25',
              )}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn(
                    cellPad,
                    'whitespace-nowrap text-gray-700',
                    column.align === 'right' && 'text-right tabular-nums',
                    column.align === 'center' && 'text-center',
                    column.sticky && 'sticky left-0 z-10 bg-inherit',
                    column.className,
                  )}
                >
                  {column.render ? column.render(row) : String((row as never)[column.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
