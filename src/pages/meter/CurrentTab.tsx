import { Activity, BarChart3 } from 'lucide-react';
import { useMeterContext } from './MeterDetailPage';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card';
import { PhaseAreaChart } from '@/components/charts/PhaseCharts';
import { ConsumptionBarChart } from '@/components/charts/ConsumptionBarChart';
import { PHASE, SERIES as SERIES_COLORS } from '@/components/charts/palette';
import { Pagination } from '@/components/ui/Pagination';
import { toChartRows, useChartPage } from '@/hooks/useChartPage';
import { getHourlyBuckets } from '@/services';

const SERIES = [
  { key: 'ir', label: 'IR', color: PHASE.r },
  { key: 'iy', label: 'IY', color: PHASE.y },
  { key: 'ib', label: 'IB', color: PHASE.b },
];

/** Per-phase current trend plus the hourly average-current bars. */
export function CurrentTab() {
  const { meter, readings } = useMeterContext();
  const { page, pageSize, total, slice, setPage } = useChartPage(readings);
  const hourly = getHourlyBuckets(meter.id);

  const data = toChartRows(slice, {
    ir: (r) => r.ir,
    iy: (r) => r.iy,
    ib: (r) => r.ib,
  });

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          icon={<Activity size={15} className="text-brand-600" aria-hidden />}
          title="Current Trend (IR / IY / IB)"
        />
        <CardBody>
          <PhaseAreaChart
            data={data}
            series={SERIES}
            unit="A"
            yLabel="Current (A)"
            decimals={2}
          />
        </CardBody>
        <CardFooter>
          <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />
        </CardFooter>
      </Card>

      <Card>
        <CardHeader
          icon={<BarChart3 size={15} className="text-brand-600" aria-hidden />}
          title="Hourly Average Current (Last 24 Hours)"
        />
        <CardBody>
          <ConsumptionBarChart
            data={hourly}
            metric="avgCurrent"
            color={SERIES_COLORS.current}
            legendLabel="Avg Current (A)"
            yLabel="Current (A)"
            unit="A"
          />
        </CardBody>
      </Card>
    </div>
  );
}
