import { useMemo, useState } from 'react';
import { Activity, BarChart3, Download, Gauge, RefreshCw, Zap } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SelectInput, TextInput } from '@/components/ui/Form';
import { EmptyState, ChartSkeleton } from '@/components/ui/States';
import { PhaseAreaChart, PhaseLineChart } from '@/components/charts/PhaseCharts';
import { ConsumptionBarChart } from '@/components/charts/ConsumptionBarChart';
import { PHASE, SERIES } from '@/components/charts/palette';
import { getDailyBuckets, getDevice, getHourlyBuckets, listMeters, listReadings } from '@/services';
import { useDeviceSelection } from '@/hooks/useDeviceSelection';
import { toChartRows } from '@/hooks/useChartPage';
import { useToast } from '@/hooks/useToast';
import { downloadCsv } from '@/utils/csv';
import { formatDateTime } from '@/utils/format';
import { cn } from '@/utils/cn';
import { useStoreVersion } from '@/hooks/useStore';

type Preset = 'today' | 'yesterday' | 'last7d' | 'last30d' | 'custom';

const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7d', label: 'Last 7 days' },
  { key: 'last30d', label: 'Last 30 days' },
  { key: 'custom', label: 'Custom range' },
];

/**
 * Energy Analytics: every trend for the selected device in one place, with the
 * period controls, aggregation switch, export and reset the brief calls for.
 */
export function DataChartsPage() {
  const { deviceId } = useDeviceSelection();
  const { toast } = useToast();

  const device = deviceId ? getDevice(deviceId) : undefined;
  const dataVersion = useStoreVersion();
  const meters = useMemo(() => listMeters(deviceId ?? undefined), [deviceId, dataVersion]);

  const [meterId, setMeterId] = useState<string>(meters[0]?.id ?? '');
  const [preset, setPreset] = useState<Preset>('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [aggregation, setAggregation] = useState<'hourly' | 'daily'>('hourly');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState(() => new Date().toISOString());

  const activeMeterId = meterId || meters[0]?.id || '';
  const readings = useMemo(
    () => (activeMeterId ? listReadings(activeMeterId) : []),
    [activeMeterId, dataVersion],
  );

  /** Applies the selected period to the reading history. */
  const scoped = useMemo(() => {
    if (readings.length === 0) return [];
    const latest = Date.parse(readings[0].timestamp);
    const DAY = 86_400_000;

    if (preset === 'custom') {
      if (!customFrom && !customTo) return readings;
      const from = customFrom ? Date.parse(`${customFrom}T00:00:00`) : -Infinity;
      const to = customTo ? Date.parse(`${customTo}T23:59:59`) : Infinity;
      return readings.filter((r) => {
        const t = Date.parse(r.timestamp);
        return t >= from && t <= to;
      });
    }

    const windows: Record<Exclude<Preset, 'custom'>, [number, number]> = {
      today: [latest - DAY, latest],
      yesterday: [latest - 2 * DAY, latest - DAY],
      last7d: [latest - 7 * DAY, latest],
      last30d: [latest - 30 * DAY, latest],
    };
    const [from, to] = windows[preset];
    return readings.filter((r) => {
      const t = Date.parse(r.timestamp);
      return t >= from && t <= to;
    });
  }, [readings, preset, customFrom, customTo]);

  // Keep the series readable: sample down to at most 60 points.
  const sampled = useMemo(() => {
    if (scoped.length <= 60) return [...scoped].reverse();
    const step = Math.ceil(scoped.length / 60);
    return scoped.filter((_, i) => i % step === 0).reverse();
  }, [scoped]);

  const hourly = activeMeterId ? getHourlyBuckets(activeMeterId) : [];
  const daily = activeMeterId ? getDailyBuckets(activeMeterId, preset === 'last30d' ? 30 : 7) : [];

  function refresh() {
    setRefreshing(true);
    window.setTimeout(() => {
      setRefreshing(false);
      setRefreshedAt(new Date().toISOString());
      toast('Readings refreshed', { variant: 'info' });
    }, 600);
  }

  function resetFilters() {
    setPreset('today');
    setCustomFrom('');
    setCustomTo('');
    setAggregation('hourly');
    setMeterId(meters[0]?.id ?? '');
  }

  function exportSeries() {
    downloadCsv(
      `analytics-${activeMeterId}.csv`,
      ['Timestamp', 'VRY', 'VYB', 'VBR', 'IR', 'IY', 'IB', 'kW total', 'PF-R', 'Frequency'],
      scoped.map((r) => [
        formatDateTime(r.timestamp),
        r.vry, r.vyb, r.vbr, r.ir, r.iy, r.ib,
        (r.kwR + r.kwY + r.kwB).toFixed(2), r.pfR, r.frequency,
      ]),
    );
    toast('Analytics exported', { description: `${scoped.length} samples written to CSV.` });
  }

  if (!deviceId || meters.length === 0) {
    return (
      <>
        <PageHeader title="Energy Analytics" icon={<Gauge size={20} aria-hidden />} />
        <Card>
          <EmptyState
            icon={<BarChart3 size={36} strokeWidth={1.5} />}
            title="No device selected"
            description="Choose a device from My Devices to view its analytics."
          />
        </Card>
      </>
    );
  }

  const voltageRows = toChartRows(sampled, {
    vry: (r) => r.vry,
    vyb: (r) => r.vyb,
    vbr: (r) => r.vbr,
  });
  const currentRows = toChartRows(sampled, {
    ir: (r) => r.ir,
    iy: (r) => r.iy,
    ib: (r) => r.ib,
  });
  const powerRows = toChartRows(sampled, {
    kwR: (r) => r.kwR,
    kwY: (r) => r.kwY,
    kwB: (r) => r.kwB,
  });
  const pfRows = toChartRows(sampled, {
    pfR: (r) => r.pfR,
    pfY: (r) => r.pfY,
    pfB: (r) => r.pfB,
  });
  const freqRows = toChartRows(sampled, { frequency: (r) => r.frequency });

  return (
    <>
      <PageHeader
        title="Energy Analytics"
        icon={<Gauge size={20} aria-hidden />}
        crumbs={[
          { label: 'Home', to: '/dashboard' },
          { label: 'Data & Logs' },
          { label: 'Charts' },
        ]}
        lastUpdated={refreshedAt}
        description={device ? `${device.name} · ${device.location}` : undefined}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh} loading={refreshing}>
              {refreshing ? null : <RefreshCw size={14} aria-hidden />}
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={exportSeries}>
              <Download size={14} aria-hidden />
              Export
            </Button>
          </>
        }
      />

      {/* Controls */}
      <Card className="mb-5">
        <CardBody className="pt-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[170px]">
              <label htmlFor="chart-meter" className="field-label">
                Meter
              </label>
              <SelectInput
                id="chart-meter"
                value={activeMeterId}
                onChange={(e) => setMeterId(e.target.value)}
              >
                {meters.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </SelectInput>
            </div>

            <div>
              <span className="field-label">Period</span>
              <div className="flex flex-wrap gap-1" role="group" aria-label="Select period">
                {PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setPreset(p.key)}
                    aria-pressed={preset === p.key}
                    className={cn(
                      'rounded-lg px-2.5 py-1.5 text-theme-xs font-medium transition-colors',
                      preset === p.key
                        ? 'bg-brand-600 text-white'
                        : 'border border-gray-200 text-gray-600 hover:bg-gray-50',
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {preset === 'custom' ? (
              <div className="flex items-end gap-2">
                <div>
                  <label htmlFor="chart-from" className="field-label">
                    From
                  </label>
                  <TextInput
                    id="chart-from"
                    type="date"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="chart-to" className="field-label">
                    To
                  </label>
                  <TextInput
                    id="chart-to"
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                  />
                </div>
              </div>
            ) : null}

            <div className="min-w-[140px]">
              <label htmlFor="chart-agg" className="field-label">
                Aggregation
              </label>
              <SelectInput
                id="chart-agg"
                value={aggregation}
                onChange={(e) => setAggregation(e.target.value as 'hourly' | 'daily')}
              >
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
              </SelectInput>
            </div>

            <Button variant="ghost" size="sm" onClick={resetFilters}>
              Reset filters
            </Button>
          </div>

          <p className="mt-3 text-theme-xs text-gray-500">
            {scoped.length.toLocaleString('en-IN')} samples in the selected period.
          </p>
        </CardBody>
      </Card>

      {scoped.length === 0 ? (
        <Card>
          <EmptyState
            title="No readings in this period"
            description="Nothing was recorded in the selected range. Widen the period or pick another meter."
            action={
              <Button variant="outline" onClick={resetFilters}>
                Reset filters
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-5">
          <Card>
            <CardHeader
              icon={<BarChart3 size={15} className="text-brand-600" aria-hidden />}
              title={
                aggregation === 'hourly'
                  ? 'Energy Consumption (Hourly)'
                  : 'Energy Consumption (Daily)'
              }
            />
            <CardBody>
              {refreshing ? (
                <ChartSkeleton />
              ) : (
                <ConsumptionBarChart
                  data={aggregation === 'hourly' ? hourly : daily}
                  metric="kwh"
                  color={SERIES.energy}
                  legendLabel={aggregation === 'hourly' ? 'kWh (per hour)' : 'kWh per day'}
                  yLabel="kWh"
                  unit="kWh"
                />
              )}
            </CardBody>
          </Card>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card>
              <CardHeader
                icon={<Zap size={15} className="text-brand-600" aria-hidden />}
                title="Voltage Trend (Line-to-Line)"
              />
              <CardBody>
                <PhaseAreaChart
                  data={voltageRows}
                  series={[
                    { key: 'vry', label: 'VRY (R-Y)', color: PHASE.r },
                    { key: 'vyb', label: 'VYB (Y-B)', color: PHASE.y },
                    { key: 'vbr', label: 'VBR (B-R)', color: PHASE.b },
                  ]}
                  unit="V"
                  yLabel="Voltage (V)"
                  decimals={2}
                  height={260}
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                icon={<Activity size={15} className="text-brand-600" aria-hidden />}
                title="Current Trend"
              />
              <CardBody>
                <PhaseAreaChart
                  data={currentRows}
                  series={[
                    { key: 'ir', label: 'IR', color: PHASE.r },
                    { key: 'iy', label: 'IY', color: PHASE.y },
                    { key: 'ib', label: 'IB', color: PHASE.b },
                  ]}
                  unit="A"
                  yLabel="Current (A)"
                  decimals={2}
                  height={260}
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                icon={<Zap size={15} className="text-brand-600" aria-hidden />}
                title="Power Trend"
              />
              <CardBody>
                <PhaseAreaChart
                  data={powerRows}
                  series={[
                    { key: 'kwR', label: 'kW-R', color: PHASE.r },
                    { key: 'kwY', label: 'kW-Y', color: PHASE.y },
                    { key: 'kwB', label: 'kW-B', color: PHASE.b },
                  ]}
                  unit="kW"
                  yLabel="Power (kW)"
                  decimals={2}
                  height={260}
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                icon={<Activity size={15} className="text-brand-600" aria-hidden />}
                title="Power Factor Trend"
              />
              <CardBody>
                <PhaseLineChart
                  data={pfRows}
                  series={[
                    { key: 'pfR', label: 'PF-R', color: PHASE.r },
                    { key: 'pfY', label: 'PF-Y', color: PHASE.y },
                    { key: 'pfB', label: 'PF-B', color: PHASE.b },
                  ]}
                  yLabel="Power Factor"
                  decimals={3}
                  height={260}
                />
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader
              icon={<Activity size={15} className="text-brand-600" aria-hidden />}
              title="Frequency Trend"
            />
            <CardBody>
              <PhaseLineChart
                data={freqRows}
                series={[{ key: 'frequency', label: 'Frequency (Hz)', color: SERIES.frequency }]}
                unit="Hz"
                yLabel="Frequency (Hz)"
                decimals={2}
                height={240}
                thresholds={
                  device
                    ? [
                        { value: device.thresholds.frequencyMax, label: 'Max', color: '#F04438' },
                        { value: device.thresholds.frequencyMin, label: 'Min', color: '#F79009' },
                      ]
                    : []
                }
              />
            </CardBody>
          </Card>
        </div>
      )}
    </>
  );
}
