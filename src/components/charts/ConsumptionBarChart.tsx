import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ConsumptionBucket } from '@/types';
import { ChartTooltip } from './ChartTooltip';
import { SingleSeriesLegend } from './SeriesLegend';
import { AXIS_COLOR, BAR_RADIUS, GRID_COLOR } from './palette';

interface ConsumptionBarChartProps {
  data: ConsumptionBucket[];
  /** Which measure to plot. */
  metric: 'kwh' | 'avgCurrent';
  color: string;
  legendLabel: string;
  yLabel?: string;
  unit?: string;
  height?: number;
  /** Clicking a bar selects it; the selection is drawn darker. */
  selectable?: boolean;
}

/**
 * The green (energy) and blue (current / daily) bar charts from the reference.
 * Bars carry 4px rounded tops and a 2px surface gap, and every bar has a hover
 * tooltip.
 */
export function ConsumptionBarChart({
  data,
  metric,
  color,
  legendLabel,
  yLabel,
  unit = '',
  height = 300,
  selectable = true,
}: ConsumptionBarChartProps) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div>
      <div className="mb-2">
        <SingleSeriesLegend label={legendLabel} color={color} />
      </div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 8, right: 12, bottom: 8, left: yLabel ? 4 : -10 }}
            barCategoryGap="18%"
          >
            <CartesianGrid stroke={GRID_COLOR} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: AXIS_COLOR }}
              tickLine={false}
              axisLine={{ stroke: GRID_COLOR }}
              interval="preserveStartEnd"
              minTickGap={8}
            />
            <YAxis
              tick={{ fontSize: 10, fill: AXIS_COLOR }}
              tickLine={false}
              axisLine={{ stroke: GRID_COLOR }}
              width={yLabel ? 52 : 40}
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
              content={<ChartTooltip unit={unit} decimals={2} />}
              cursor={{ fill: 'rgba(16,24,40,0.04)' }}
            />
            <Bar
              dataKey={metric}
              name={legendLabel}
              radius={BAR_RADIUS}
              isAnimationActive={false}
              onClick={
                selectable
                  ? (entry: unknown) => {
                      const at = (entry as ConsumptionBucket | undefined)?.at ?? null;
                      setSelected((prev) => (prev === at ? null : at));
                    }
                  : undefined
              }
              className={selectable ? 'cursor-pointer' : undefined}
            >
              {data.map((bucket) => (
                <Cell
                  key={bucket.at}
                  fill={color}
                  fillOpacity={selected === null || selected === bucket.at ? 1 : 0.35}
                  // 2px surface gap between adjacent bars
                  stroke="#fff"
                  strokeWidth={1}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {selected ? (
        <p className="mt-1 text-center text-theme-2xs text-gray-500">
          Highlighting {data.find((d) => d.at === selected)?.label}. Click the bar again to clear.
        </p>
      ) : null}
    </div>
  );
}
