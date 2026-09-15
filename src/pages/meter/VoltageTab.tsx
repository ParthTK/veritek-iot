import { Zap } from 'lucide-react';
import { useMeterContext } from './MeterDetailPage';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card';
import { PhaseAreaChart } from '@/components/charts/PhaseCharts';
import { PHASE } from '@/components/charts/palette';
import { Pagination } from '@/components/ui/Pagination';
import { toChartRows, useChartPage } from '@/hooks/useChartPage';
import { getDevice } from '@/services';

const SERIES = [
  { key: 'vry', label: 'VRY (R-Y)', color: PHASE.r },
  { key: 'vyb', label: 'VYB (Y-B)', color: PHASE.y },
  { key: 'vbr', label: 'VBR (B-R)', color: PHASE.b },
];

/** Line-to-line voltage across the three phase pairs. */
export function VoltageTab() {
  const { meter, readings } = useMeterContext();
  const { page, pageSize, total, slice, setPage } = useChartPage(readings);
  const device = getDevice(meter.deviceId);

  const data = toChartRows(slice, {
    vry: (r) => r.vry,
    vyb: (r) => r.vyb,
    vbr: (r) => r.vbr,
  });

  return (
    <Card>
      <CardHeader
        icon={<Zap size={15} className="text-brand-600" aria-hidden />}
        title="Line-to-Line Voltage"
      />
      <CardBody>
        <PhaseAreaChart
          data={data}
          series={SERIES}
          unit="V"
          yLabel="Voltage (V)"
          decimals={2}
          thresholds={
            device
              ? [
                  { value: device.thresholds.voltageMax, label: 'Max', color: '#F04438' },
                  { value: device.thresholds.voltageMin, label: 'Min', color: '#F79009' },
                ]
              : []
          }
        />
      </CardBody>
      <CardFooter>
        <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />
      </CardFooter>
    </Card>
  );
}
