import { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartTooltip } from './ChartTooltip';
import { SeriesLegend } from './SeriesLegend';
import type { SeriesDef } from './SeriesLegend';
import {
  ACTIVE_DOT_RADIUS,
  AXIS_COLOR,
  DOT_RADIUS,
  GRID_COLOR,
  STROKE_WIDTH,
} from './palette';

export interface ThresholdLine {
  value: number;
  label: string;
  color?: string;
}

interface PhaseChartProps {
  /** Rows already shaped as `{ label, [seriesKey]: number }`. */
  data: Array<Record<string, string | number>>;
  series: SeriesDef[];
  unit?: string;
  yLabel?: string;
  decimals?: number;
  height?: number;
  thresholds?: ThresholdLine[];
  /** Domain padding so lines never touch the plot edges. */
  yDomain?: [number | 'auto', number | 'auto'];
}

function useHidden(series: SeriesDef[]) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const visible = useMemo(() => series.filter((s) => !hidden.has(s.key)), [series, hidden]);
  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      // Keep at least one series on screen.
      if (next.has(key)) next.delete(key);
      else if (prev.size < series.length - 1) next.add(key);
      return next;
    });
  return { hidden, visible, toggle };
}

const AXIS_PROPS = {
  tick: { fontSize: 10, fill: AXIS_COLOR },
  tickLine: false,
  axisLine: { stroke: GRID_COLOR },
} as const;

/**
 * Overlapping filled areas — the shape used for line-to-line voltage and the
 * current trend in the reference capture.
 */
export function PhaseAreaChart({
  data,
  series,
  unit = '',
  yLabel,
  decimals = 1,
  height = 300,
  thresholds = [],
  yDomain = ['auto', 'auto'],
}: PhaseChartProps) {
  const { hidden, visible, toggle } = useHidden(series);

  return (
    <div>
      <div className="mb-2">
        <SeriesLegend series={series} hidden={hidden} onToggle={toggle} />
      </div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: yLabel ? 4 : -8 }}>
            <defs>
              {series.map((s) => (
                <linearGradient key={s.key} id={`fill-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid stroke={GRID_COLOR} vertical={false} />
            <XAxis dataKey="label" {...AXIS_PROPS} minTickGap={28} />
            <YAxis
              {...AXIS_PROPS}
              width={yLabel ? 52 : 44}
              domain={yDomain}
              label={
                yLabel
                  ? {
                      value: yLabel,
                      angle: -90,
                      position: 'insideLeft',
                      style: { fontSize: 10, fill: AXIS_COLOR, textAnchor: 'middle' },
                    }
                  : undefined
              }
            />
            <Tooltip
              content={<ChartTooltip unit={unit} decimals={decimals} />}
              cursor={{ stroke: AXIS_COLOR, strokeDasharray: '3 3' }}
            />
            {thresholds.map((t) => (
              <ReferenceLine
                key={t.label}
                y={t.value}
                stroke={t.color ?? '#F04438'}
                strokeDasharray="5 4"
                strokeWidth={1.5}
                label={{
                  value: t.label,
                  position: 'right',
                  style: { fontSize: 9, fill: t.color ?? '#F04438' },
                }}
              />
            ))}
            {visible.map((s) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={STROKE_WIDTH}
                fill={`url(#fill-${s.key})`}
                dot={{ r: DOT_RADIUS, fill: s.color, strokeWidth: 0 }}
                activeDot={{ r: ACTIVE_DOT_RADIUS, stroke: '#fff', strokeWidth: 2 }}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Plain multi-line chart with no fill — the power-factor diagnostic view. */
export function PhaseLineChart({
  data,
  series,
  unit = '',
  yLabel,
  decimals = 3,
  height = 300,
  thresholds = [],
  yDomain = ['auto', 'auto'],
}: PhaseChartProps) {
  const { hidden, visible, toggle } = useHidden(series);

  return (
    <div>
      <div className="mb-2">
        <SeriesLegend series={series} hidden={hidden} onToggle={toggle} />
      </div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: yLabel ? 4 : -8 }}>
            <CartesianGrid stroke={GRID_COLOR} vertical={false} />
            <XAxis dataKey="label" {...AXIS_PROPS} minTickGap={28} />
            <YAxis
              {...AXIS_PROPS}
              width={yLabel ? 52 : 44}
              domain={yDomain}
              label={
                yLabel
                  ? {
                      value: yLabel,
                      angle: -90,
                      position: 'insideLeft',
                      style: { fontSize: 10, fill: AXIS_COLOR, textAnchor: 'middle' },
                    }
                  : undefined
              }
            />
            <Tooltip
              content={<ChartTooltip unit={unit} decimals={decimals} />}
              cursor={{ stroke: AXIS_COLOR, strokeDasharray: '3 3' }}
            />
            {thresholds.map((t) => (
              <ReferenceLine
                key={t.label}
                y={t.value}
                stroke={t.color ?? '#F04438'}
                strokeDasharray="5 4"
                strokeWidth={1.5}
                label={{
                  value: t.label,
                  position: 'right',
                  style: { fontSize: 9, fill: t.color ?? '#F04438' },
                }}
              />
            ))}
            {visible.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={STROKE_WIDTH}
                dot={{ r: DOT_RADIUS, fill: s.color, strokeWidth: 0 }}
                activeDot={{ r: ACTIVE_DOT_RADIUS, stroke: '#fff', strokeWidth: 2 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
