import type { TooltipProps } from 'recharts';

/**
 * Dark rounded tooltip matching the one seen hovering the reference's bar
 * charts. Series identity is carried by both a colour chip and its name, so
 * the tooltip never relies on colour alone.
 */
export function ChartTooltip({
  active,
  payload,
  label,
  unit = '',
  decimals = 2,
}: TooltipProps<number, string> & { unit?: string; decimals?: number }) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="rounded-md bg-gray-900/95 px-2.5 py-2 shadow-theme-lg">
      <p className="mb-1 text-theme-2xs font-medium text-white">{label}</p>
      <ul className="space-y-0.5">
        {payload.map((entry) => (
          <li key={String(entry.dataKey)} className="flex items-center gap-1.5 whitespace-nowrap">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-sm"
              style={{ backgroundColor: entry.color }}
              aria-hidden
            />
            <span className="text-theme-2xs text-gray-300">{entry.name}:</span>
            <span className="text-theme-2xs font-semibold tabular-nums text-white">
              {typeof entry.value === 'number' ? entry.value.toFixed(decimals) : entry.value}
              {unit ? ` ${unit}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
