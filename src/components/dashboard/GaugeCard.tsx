import { PHASE } from '@/components/charts/palette';
import { formatNumber } from '@/utils/format';
import { clamp } from '@/utils/random';
import { cn } from '@/utils/cn';

export type GaugeTone = 'normal' | 'warning' | 'critical' | 'idle';

const TONE_COLOR: Record<GaugeTone, string> = {
  normal: '#12B76A',
  warning: '#F79009',
  critical: '#F04438',
  idle: '#D0D5DD',
};

interface GaugeCardProps {
  title: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  tone: GaugeTone;
  decimals?: number;
  /** Per-phase readouts rendered under the value, as in the reference. */
  phases?: { label: 'R' | 'Y' | 'B'; value: number }[];
  phaseUnit?: string;
  phaseDecimals?: number;
}

const PHASE_COLOR = { R: PHASE.r, Y: PHASE.y, B: PHASE.b } as const;

/**
 * Semicircular gauge card from the reference Overview tab: a 180° arc, the
 * reading below it, then the three phase values in R/Y/B order.
 *
 * The arc is an SVG path rather than a chart library radial — it needs to be a
 * fixed half-circle with a rounded cap, which is fiddly to pin down in Recharts.
 */
export function GaugeCard({
  title,
  value,
  unit,
  min,
  max,
  tone,
  decimals = 1,
  phases,
  phaseUnit = '',
  phaseDecimals = 1,
}: GaugeCardProps) {
  const ratio = max > min ? clamp((value - min) / (max - min), 0, 1) : 0;

  // Semicircle from (10,60) to (110,60), radius 50.
  const radius = 50;
  const circumference = Math.PI * radius;
  const dash = circumference * ratio;
  const color = TONE_COLOR[tone];

  return (
    <div className="card flex flex-col items-center px-4 py-4">
      <h3 className="text-theme-2xs font-semibold uppercase tracking-wide text-gray-500">
        {title}
      </h3>

      <svg
        viewBox="0 0 120 70"
        className="mt-2 w-[132px]"
        role="img"
        aria-label={`${title}: ${formatNumber(value, decimals)} ${unit}`}
      >
        <path
          d="M 10 60 A 50 50 0 0 1 110 60"
          fill="none"
          stroke="#EAECF0"
          strokeWidth="9"
          strokeLinecap="round"
        />
        <path
          d="M 10 60 A 50 50 0 0 1 110 60"
          fill="none"
          stroke={color}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
        />
      </svg>

      <p className="-mt-1 text-theme-xl font-bold tabular-nums text-gray-900">
        {formatNumber(value, decimals)}
        <span className="ml-1 text-theme-sm font-medium text-gray-500">{unit}</span>
      </p>

      {phases ? (
        <dl className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          {phases.map((p) => (
            <div key={p.label} className="flex items-center gap-1">
              <dt
                className="text-theme-2xs font-semibold"
                style={{ color: PHASE_COLOR[p.label] }}
              >
                {p.label}:
              </dt>
              <dd className="text-theme-2xs font-medium tabular-nums text-gray-700">
                {formatNumber(p.value, phaseDecimals)}
                {phaseUnit}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

/** Compact KPI card: label, big value, sub-line, optional trend. */
export function StatCard({
  label,
  value,
  sub,
  icon,
  accent,
  trend,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon?: React.ReactNode;
  accent?: 'brand' | 'success' | 'warning' | 'error';
  trend?: { direction: 'up' | 'down'; value: string };
}) {
  const accentBar = {
    brand: 'before:bg-brand-500',
    success: 'before:bg-success-500',
    warning: 'before:bg-warning-500',
    error: 'before:bg-error-500',
  };

  return (
    <div
      className={cn(
        'card relative overflow-hidden px-4 py-3.5',
        accent &&
          `before:absolute before:left-0 before:top-0 before:h-full before:w-1 ${accentBar[accent]}`,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-theme-2xs font-semibold uppercase tracking-wide text-gray-500">
            {label}
          </p>
          <p className="mt-1 text-title-sm font-bold leading-none tabular-nums text-gray-900">
            {value}
          </p>
          {sub ? <p className="mt-1.5 text-theme-xs text-gray-500">{sub}</p> : null}
          {trend ? (
            <p
              className={cn(
                'mt-1.5 inline-flex items-center gap-1 text-theme-2xs font-medium',
                trend.direction === 'up' ? 'text-success-600' : 'text-error-600',
              )}
            >
              {trend.direction === 'up' ? '▲' : '▼'} {trend.value}
            </p>
          ) : null}
        </div>
        {icon ? <div className="shrink-0 text-gray-200">{icon}</div> : null}
      </div>
    </div>
  );
}
