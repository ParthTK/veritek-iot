import { AlertTriangle, BarChart3, CheckCircle2, Power, WifiOff } from 'lucide-react';
import { useMeterContext } from './MeterDetailPage';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card';
import { PhaseLineChart } from '@/components/charts/PhaseCharts';
import { PHASE } from '@/components/charts/palette';
import { Pagination } from '@/components/ui/Pagination';
import { SeverityBadge } from '@/components/ui/Badge';
import { toChartRows, useChartPage } from '@/hooks/useChartPage';
import { getDevice, listDiagnosticEvents } from '@/services';
import { statsForPhases } from '@/data/readings';
import { formatDateTime, formatNumber, formatRelative } from '@/utils/format';

const PF_SERIES = [
  { key: 'pfR', label: 'PF-R', color: PHASE.r },
  { key: 'pfY', label: 'PF-Y', color: PHASE.y },
  { key: 'pfB', label: 'PF-B', color: PHASE.b },
];

const KIND_ICON = {
  'normal-voltage': CheckCircle2,
  'high-voltage': AlertTriangle,
  'low-power-factor': AlertTriangle,
  'consumption-spike': AlertTriangle,
  'device-disconnected': WifiOff,
} as const;

/**
 * Diagnostic: the power-factor trend from the reference, extended with the
 * device health summary and abnormal-reading markers the brief asks for.
 */
export function DiagnosticTab() {
  const { meter, readings } = useMeterContext();
  const { page, pageSize, total, slice, setPage } = useChartPage(readings);
  const device = getDevice(meter.deviceId);
  const events = listDiagnosticEvents(meter.deviceId);

  const data = toChartRows(slice, {
    pfR: (r) => r.pfR,
    pfY: (r) => r.pfY,
    pfB: (r) => r.pfB,
  });

  const pfStats = statsForPhases(readings, [(r) => r.pfR, (r) => r.pfY, (r) => r.pfB]);
  const voltageStats = statsForPhases(readings, [(r) => r.vry, (r) => r.vyb, (r) => r.vbr]);
  const t = device?.thresholds;

  // Count genuine excursions only. This meter's power factor sits chronically
  // below target, so comparing every sample against powerFactorMin would flag
  // almost the whole series; the health card above reports that condition
  // separately. Here we want spikes and dips, not the baseline.
  const abnormal = readings.filter((r) => {
    if (!t) return false;
    const overVoltage = Math.max(r.vry, r.vyb, r.vbr) > t.voltageMax;
    const underVoltage = Math.min(r.vry, r.vyb, r.vbr) < t.voltageMin;
    const severeLowPf = Math.min(r.pfR, r.pfY, r.pfB) < t.powerFactorMin * 0.6;
    const overCurrent = Math.max(r.ir, r.iy, r.ib) > t.currentMax * 0.9;
    return overVoltage || underVoltage || severeLowPf || overCurrent;
  }).length;

  const health = [
    {
      label: 'Connection',
      value: device?.status === 'online' ? 'Online' : device?.status === 'warning' ? 'Warning' : 'Offline',
      tone:
        device?.status === 'online'
          ? 'text-success-600'
          : device?.status === 'warning'
            ? 'text-warning-600'
            : 'text-error-600',
      sub: device ? `Last seen ${formatRelative(device.lastSeen, Date.parse('2025-11-22T11:35:00+05:30'))}` : '',
    },
    {
      label: 'Voltage Health',
      value: t && voltageStats.maximum > t.voltageMax ? 'Out of band' : 'Within band',
      tone: t && voltageStats.maximum > t.voltageMax ? 'text-error-600' : 'text-success-600',
      sub: `Peak ${formatNumber(voltageStats.maximum, 2)} V`,
    },
    {
      label: 'Power Factor',
      value: t && pfStats.average < t.powerFactorMin ? 'Below target' : 'Healthy',
      tone: t && pfStats.average < t.powerFactorMin ? 'text-warning-600' : 'text-success-600',
      sub: `Average ${formatNumber(pfStats.average, 3)}`,
    },
    {
      label: 'Abnormal Readings',
      value: String(abnormal),
      tone: abnormal > 0 ? 'text-warning-600' : 'text-success-600',
      sub: `Of ${readings.length} samples`,
    },
  ];

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {health.map((card) => (
          <div key={card.label} className="card px-4 py-3">
            <p className="text-theme-2xs font-semibold uppercase tracking-wide text-gray-500">
              {card.label}
            </p>
            <p className={`mt-1 text-theme-lg font-bold ${card.tone}`}>{card.value}</p>
            <p className="mt-0.5 text-theme-xs text-gray-500">{card.sub}</p>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader
          icon={<BarChart3 size={15} className="text-brand-600" aria-hidden />}
          title="Power Factor (PF-R, PF-Y, PF-B)"
          description={
            t ? `Dashed line marks the ${t.powerFactorMin} minimum power factor threshold.` : undefined
          }
        />
        <CardBody>
          <PhaseLineChart
            data={data}
            series={PF_SERIES}
            yLabel="Power Factor"
            decimals={3}
            yDomain={[0, 'auto']}
            thresholds={
              t ? [{ value: t.powerFactorMin, label: 'Min PF', color: '#F79009' }] : []
            }
          />
        </CardBody>
        <CardFooter>
          <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />
        </CardFooter>
      </Card>

      <Card>
        <CardHeader
          icon={<Power size={15} className="text-brand-600" aria-hidden />}
          title="Diagnostic Events"
          description="Conditions detected on this device"
        />
        <CardBody className="pt-0">
          <ul className="divide-y divide-gray-100">
            {events.length === 0 ? (
              <li className="py-6 text-center text-theme-xs text-gray-500">
                No diagnostic events recorded for this device.
              </li>
            ) : (
              events.map((event) => {
                const Icon = KIND_ICON[event.kind];
                return (
                  <li key={event.id} className="flex items-start gap-3 py-3">
                    <Icon
                      size={17}
                      className={
                        event.severity === 'critical'
                          ? 'mt-0.5 shrink-0 text-error-500'
                          : event.severity === 'warning'
                            ? 'mt-0.5 shrink-0 text-warning-500'
                            : 'mt-0.5 shrink-0 text-success-500'
                      }
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-theme-sm font-medium text-gray-800">{event.label}</p>
                        <SeverityBadge severity={event.severity} />
                      </div>
                      <p className="mt-0.5 text-theme-xs text-gray-500">{event.detail}</p>
                    </div>
                    <p className="shrink-0 text-theme-2xs text-gray-400">
                      {formatDateTime(event.timestamp)}
                    </p>
                  </li>
                );
              })
            )}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
