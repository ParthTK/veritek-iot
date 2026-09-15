import { cn } from '@/utils/cn';

export interface SeriesDef {
  key: string;
  label: string;
  color: string;
}

interface SeriesLegendProps {
  series: SeriesDef[];
  hidden: Set<string>;
  onToggle: (key: string) => void;
}

/**
 * The circular legend toggles used throughout the reference. Each entry is a
 * real checkbox so the series can be shown/hidden from the keyboard, and the
 * label text means identity never rests on colour alone.
 */
export function SeriesLegend({ series, hidden, onToggle }: SeriesLegendProps) {
  return (
    <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5">
      {series.map((s) => {
        const isOn = !hidden.has(s.key);
        return (
          <li key={s.key}>
            <label className="flex cursor-pointer select-none items-center gap-1.5">
              <input
                type="checkbox"
                checked={isOn}
                onChange={() => onToggle(s.key)}
                className="sr-only"
              />
              <span
                aria-hidden
                className={cn(
                  'flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 transition-colors',
                )}
                style={{
                  borderColor: s.color,
                  backgroundColor: isOn ? s.color : 'transparent',
                }}
              />
              <span
                className={cn(
                  'text-theme-2xs transition-colors',
                  isOn ? 'text-gray-700' : 'text-gray-400 line-through',
                )}
              >
                {s.label}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/** Static swatch + label for single-series charts (no toggling). */
export function SingleSeriesLegend({ label, color }: { label: string; color: string }) {
  return (
    <div className="flex items-center justify-center gap-1.5">
      <span
        className="inline-block h-2.5 w-6 rounded-sm"
        style={{ backgroundColor: color }}
        aria-hidden
      />
      <span className="text-theme-2xs text-gray-600">{label}</span>
    </div>
  );
}
