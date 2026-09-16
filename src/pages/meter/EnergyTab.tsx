import { useMemo, useState } from 'react';
import { BarChart3, Download } from 'lucide-react';
import { useMeterContext } from './MeterDetailPage';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { ConsumptionBarChart } from '@/components/charts/ConsumptionBarChart';
import { SERIES } from '@/components/charts/palette';
import { Button } from '@/components/ui/Button';
import { SelectInput } from '@/components/ui/Form';
import { getDailyBuckets, getHourlyBuckets } from '@/services';
import { useToast } from '@/hooks/useToast';
import { formatNumber } from '@/utils/format';
import { downloadCsv } from '@/utils/csv';
import { useStoreVersion } from '@/hooks/useStore';

type SortMode = 'chronological' | 'highest' | 'lowest';

/**
 * Energy tab: hourly consumption in green and daily consumption in blue, the
 * two bar charts shown in the reference, plus period totals and comparison.
 */
export function EnergyTab() {
  const { meter } = useMeterContext();
  const { toast } = useToast();

  const [days, setDays] = useState(7);
  const [sort, setSort] = useState<SortMode>('chronological');

  const hourly = getHourlyBuckets(meter.id);
  const dataVersion = useStoreVersion();
  const daily = useMemo(() => getDailyBuckets(meter.id, days), [meter.id, days, dataVersion]);
  const previous = useMemo(() => getDailyBuckets(meter.id, days * 2), [meter.id, days, dataVersion]);

  const sortedDaily = useMemo(() => {
    if (sort === 'highest') return [...daily].sort((a, b) => b.kwh - a.kwh);
    if (sort === 'lowest') return [...daily].sort((a, b) => a.kwh - b.kwh);
    return daily;
  }, [daily, sort]);

  const total = daily.reduce((sum, b) => sum + b.kwh, 0);
  const average = daily.length > 0 ? total / daily.length : 0;
  const priorTotal = previous.slice(0, days).reduce((sum, b) => sum + b.kwh, 0);
  const change = priorTotal > 0 ? ((total - priorTotal) / priorTotal) * 100 : 0;

  const peak = hourly.reduce((max, b) => (b.kwh > max.kwh ? b : max), hourly[0]);
  const lowest = hourly.reduce((min, b) => (b.kwh < min.kwh ? b : min), hourly[0]);

  function exportBreakdown() {
    downloadCsv(
      `${meter.name}-consumption-${days}d.csv`,
      ['Period', 'Energy (kWh)', 'Avg Current (A)'],
      sortedDaily.map((b) => [b.label, b.kwh, b.avgCurrent]),
    );
    toast('Report downloaded', {
      description: `${meter.name} consumption breakdown exported as CSV.`,
    });
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Total Consumption', value: `${formatNumber(total, 2)} kWh`, sub: `Last ${days} days` },
          { label: 'Average per Day', value: `${formatNumber(average, 2)} kWh`, sub: 'Across the period' },
          {
            label: 'Peak Demand Hour',
            value: peak ? `${formatNumber(peak.kwh, 2)} kWh` : '—',
            sub: peak ? `at ${peak.label}` : '',
          },
          {
            label: 'Lowest Hour',
            value: lowest ? `${formatNumber(lowest.kwh, 2)} kWh` : '—',
            sub: lowest ? `at ${lowest.label}` : '',
          },
        ].map((tile) => (
          <div key={tile.label} className="card px-4 py-3">
            <p className="text-theme-2xs font-semibold uppercase tracking-wide text-gray-500">
              {tile.label}
            </p>
            <p className="mt-1 text-theme-xl font-bold tabular-nums text-gray-900">{tile.value}</p>
            <p className="mt-0.5 text-theme-xs text-gray-500">{tile.sub}</p>
          </div>
        ))}
      </div>

      <div className="card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-theme-xs text-gray-600">
            Period
            <SelectInput
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="h-8 w-auto py-0 text-theme-xs"
              aria-label="Consumption period"
            >
              <option value={7}>Last 7 days</option>
              <option value={14}>Last 14 days</option>
              <option value={30}>Last 30 days</option>
            </SelectInput>
          </label>
          <label className="flex items-center gap-2 text-theme-xs text-gray-600">
            Sort
            <SelectInput
              value={sort}
              onChange={(e) => setSort(e.target.value as SortMode)}
              className="h-8 w-auto py-0 text-theme-xs"
              aria-label="Sort daily consumption"
            >
              <option value="chronological">Chronological</option>
              <option value="highest">Highest first</option>
              <option value="lowest">Lowest first</option>
            </SelectInput>
          </label>
        </div>

        <div className="flex items-center gap-3">
          <p className="text-theme-xs text-gray-600">
            vs previous period{' '}
            <span
              className={`font-semibold ${change >= 0 ? 'text-error-600' : 'text-success-600'}`}
            >
              {change >= 0 ? '▲' : '▼'} {formatNumber(Math.abs(change), 1)}%
            </span>
          </p>
          <Button variant="outline" size="sm" onClick={exportBreakdown}>
            <Download size={14} aria-hidden />
            Export
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader
          icon={<BarChart3 size={15} className="text-brand-600" aria-hidden />}
          title="Hourly Energy Consumption (Last 24 Hours)"
        />
        <CardBody>
          <ConsumptionBarChart
            data={hourly}
            metric="kwh"
            color={SERIES.energy}
            legendLabel="kWh (per hour)"
            yLabel="kWh"
            unit="kWh"
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          icon={<BarChart3 size={15} className="text-brand-600" aria-hidden />}
          title={`Daily Energy Consumption (Last ${days} Days)`}
        />
        <CardBody>
          <ConsumptionBarChart
            data={sortedDaily}
            metric="kwh"
            color={SERIES.power}
            legendLabel="kWh per day"
            yLabel="kWh"
            unit="kWh"
          />
        </CardBody>
      </Card>
    </div>
  );
}
