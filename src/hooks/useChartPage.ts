import { useMemo, useState } from 'react';
import type { Reading } from '@/types';
import { formatAxisTime } from '@/utils/format';

export const CHART_PAGE_SIZE = 30;

/**
 * Pages a reading series 30 points at a time, matching the reference charts'
 * "Showing 1-30 of 500" footer. Points are returned oldest-first within the
 * page so the x-axis reads left to right.
 */
export function useChartPage(readings: Reading[], pageSize = CHART_PAGE_SIZE) {
  const [page, setPage] = useState(1);
  const total = readings.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);

  const slice = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return readings.slice(start, start + pageSize).slice().reverse();
  }, [readings, safePage, pageSize]);

  return {
    page: safePage,
    pageSize,
    total,
    totalPages,
    slice,
    setPage,
  };
}

/** Shapes a page of readings into Recharts rows keyed by series name. */
export function toChartRows(
  rows: Reading[],
  picks: Record<string, (r: Reading) => number>,
): Array<Record<string, string | number>> {
  return rows.map((r) => {
    const out: Record<string, string | number> = { label: formatAxisTime(r.timestamp) };
    for (const [key, pick] of Object.entries(picks)) out[key] = pick(r);
    return out;
  });
}
