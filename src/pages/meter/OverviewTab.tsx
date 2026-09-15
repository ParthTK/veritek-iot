import { Activity, BarChart3, Zap } from 'lucide-react';
import { useMeterContext } from './MeterDetailPage';
import { GaugeCard } from '@/components/dashboard/GaugeCard';
import type { GaugeTone } from '@/components/dashboard/GaugeCard';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { getDevice } from '@/services';
import {
  avgCurrent,
  avgPowerFactor,
  avgVoltageLL,
  statsFor,
  statsForPhases,
} from '@/data/readings';
import { formatNumber } from '@/utils/format';

/**
 * Overview: three semicircular gauges over a statistical min/max/average
 * summary, reproducing the reference's landing tab.
 */
export function OverviewTab() {
  const { meter, readings } = useMeterContext();
  const latest = readings[0];
  const device = getDevice(meter.deviceId);
  const t = device?.thresholds;

  if (!latest) return null;

  const voltage = avgVoltageLL(latest);
  const current = avgCurrent(latest);
  const pf = avgPowerFactor(latest);

  const voltageTone: GaugeTone =
    t && (voltage > t.voltageMax || voltage < t.voltageMin)
      ? 'critical'
      : t && voltage > t.voltageMax * 0.97
        ? 'warning'
        : 'normal';
  const currentTone: GaugeTone =
    t && current > t.currentMax ? 'critical' : current < 1 ? 'idle' : 'normal';
  const pfTone: GaugeTone = t && pf < t.powerFactorMin ? 'warning' : 'normal';

  // Summary extremes come from the individual phases, matching the reference.
  const voltageStats = statsForPhases(readings, [(r) => r.vry, (r) => r.vyb, (r) => r.vbr]);
  const currentStats = statsForPhases(readings, [(r) => r.ir, (r) => r.iy, (r) => r.ib]);
  const pfStats = statsForPhases(readings, [(r) => r.pfR, (r) => r.pfY, (r) => r.pfB]);
  const freqStats = statsFor(readings, (r) => r.frequency);

  const SUMMARY = [
    { icon: Zap, title: 'Voltage (V)', stats: voltageStats, unit: 'V', decimals: 2 },
    { icon: Activity, title: 'Current (A)', stats: currentStats, unit: 'A', decimals: 2 },
    { icon: Activity, title: 'Power Factor', stats: pfStats, unit: '', decimals: 3 },
    { icon: Activity, title: 'Frequency (Hz)', stats: freqStats, unit: 'Hz', decimals: 2 },
  ];

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <GaugeCard
          title="Voltage-LL"
          value={voltage}
          unit="V"
          min={t?.voltageMin ?? 340}
          max={t?.voltageMax ?? 460}
          tone={voltageTone}
          phases={[
            { label: 'R', value: latest.vry },
            { label: 'Y', value: latest.vyb },
            { label: 'B', value: latest.vbr },
          ]}
          phaseUnit="V"
        />
        <GaugeCard
          title="Current"
          value={current}
          unit="A"
          min={0}
          max={t?.currentMax ?? 160}
          tone={currentTone}
          phases={[
            { label: 'R', value: latest.ir },
            { label: 'Y', value: latest.iy },
            { label: 'B', value: latest.ib },
          ]}
          phaseUnit="A"
        />
        <GaugeCard
          title="Power Factor"
          value={pf}
          unit=""
          min={0}
          max={1}
          tone={pfTone}
          decimals={2}
          phases={[
            { label: 'R', value: latest.pfR },
            { label: 'Y', value: latest.pfY },
            { label: 'B', value: latest.pfB },
          ]}
          phaseDecimals={2}
        />
        <GaugeCard
          title="Frequency"
          value={latest.frequency}
          unit="Hz"
          min={48}
          max={52}
          tone={
            t && (latest.frequency < t.frequencyMin || latest.frequency > t.frequencyMax)
              ? 'warning'
              : 'normal'
          }
          decimals={2}
        />
      </div>

      <Card className="mt-5">
        <CardHeader
          icon={<BarChart3 size={15} className="text-brand-600" aria-hidden />}
          title="Statistical Summary"
          description={`Across the last ${readings.length} readings`}
        />
        <CardBody>
          <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-4">
            {SUMMARY.map((group) => (
              <div key={group.title}>
                <h3 className="mb-2 flex items-center gap-1.5 text-theme-sm font-semibold text-gray-800">
                  <group.icon size={14} className="text-brand-600" aria-hidden />
                  {group.title}
                </h3>
                <dl className="divide-y divide-gray-100">
                  {(
                    [
                      ['Maximum', group.stats.maximum],
                      ['Minimum', group.stats.minimum],
                      ['Average', group.stats.average],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between py-1.5">
                      <dt className="text-theme-xs text-gray-500">{label}</dt>
                      <dd className="text-theme-sm font-semibold tabular-nums text-gray-800">
                        {formatNumber(value, group.decimals)}
                        {group.unit ? (
                          <span className="ml-1 font-normal text-gray-500">{group.unit}</span>
                        ) : null}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>
    </>
  );
}
