import { useMemo, useState } from 'react';
import {
  BarChart3,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  IndianRupee,
  Info,
  Table2,
} from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, RadioCard, TextInput } from '@/components/ui/Form';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/States';
import {
  getDevice,
  getState,
  listMeters,
  listReadings,
  setGeneral,
  siteName,
} from '@/services';
import { useDeviceSelection } from '@/hooks/useDeviceSelection';
import { useStore } from '@/hooks/useStore';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, formatDateOnly, formatDateTime, formatNumber } from '@/utils/format';
import { downloadCsv, downloadPdfStub } from '@/utils/csv';
import { totalPower } from '@/data/readings';
import { cn } from '@/utils/cn';

type RangeKey = 'last24h' | 'last7d' | 'last30d' | 'custom';
type ReportType = 'raw' | 'analytical' | 'consumption';
type Format = 'csv' | 'pdf';

const RANGES: { key: RangeKey; label: string; iconClass: string }[] = [
  { key: 'last24h', label: 'Last 24 Hours', iconClass: 'text-brand-500' },
  { key: 'last7d', label: 'Last 7 Days', iconClass: 'text-success-500' },
  { key: 'last30d', label: 'Last 30 Days', iconClass: 'text-warning-500' },
  { key: 'custom', label: 'Custom Range', iconClass: 'text-error-500' },
];

const REPORT_TYPES: { key: ReportType; label: string; description: string }[] = [
  { key: 'raw', label: 'Raw Data Report', description: 'Complete list of technical columns' },
  { key: 'analytical', label: 'Analytical Report', description: 'Statistical analysis with charts' },
  { key: 'consumption', label: 'Consumption & Cost', description: 'Energy billing report' },
];

const REPORT_TYPE_LABEL: Record<ReportType, string> = {
  raw: 'Raw Data Report',
  analytical: 'Analytical Report',
  consumption: 'Consumption & Cost Analysis',
};

/** The "Enhanced Report Generator" screen, including the unit-price modal. */
export function ReportsPage() {
  const { deviceId } = useDeviceSelection();
  const general = useStore((s) => s.general);
  const { toast } = useToast();

  const device = deviceId ? getDevice(deviceId) : undefined;
  const meters = useMemo(() => listMeters(deviceId ?? undefined), [deviceId]);
  const meter = meters[0];

  const [range, setRange] = useState<RangeKey>('last30d');
  const [reportType, setReportType] = useState<ReportType>('raw');
  const [format, setFormat] = useState<Format>('csv');
  const [customFrom, setCustomFrom] = useState('2025-10-23');
  const [customTo, setCustomTo] = useState('2025-11-22');
  const [priceOpen, setPriceOpen] = useState(false);
  const [priceDraft, setPriceDraft] = useState(String(general.unitPrice));
  const [priceError, setPriceError] = useState<string | null>(null);

  const rangeLabel =
    range === 'custom'
      ? `${formatDateOnly(customFrom)} to ${formatDateOnly(customTo)}`
      : (RANGES.find((r) => r.key === range)?.label ?? '');

  const readings = useMemo(() => (meter ? listReadings(meter.id) : []), [meter]);

  const totalKwh = useMemo(
    () => readings.reduce((sum, r) => sum + (totalPower(r) * 3) / 60, 0),
    [readings],
  );

  if (!deviceId || !device || !meter) {
    return (
      <>
        <PageHeader title="Report Generator" icon={<FileText size={20} aria-hidden />} />
        <Card>
          <EmptyState
            icon={<FileText size={36} strokeWidth={1.5} />}
            title="No device selected"
            description="Choose a device from My Devices to generate a report."
          />
        </Card>
      </>
    );
  }

  function applyPrice() {
    const value = Number(priceDraft);
    if (Number.isNaN(value) || value <= 0) {
      setPriceError('Enter a price greater than zero.');
      return;
    }
    setGeneral({ ...getState().general, unitPrice: value });
    setPriceError(null);
    setPriceOpen(false);
    toast('Unit price updated', { description: `Cost now calculated at ${formatCurrency(value)} per kWh.` });
  }

  function generate() {
    const filename = `${meter.name}-${reportType}-report`;

    if (format === 'csv') {
      if (reportType === 'consumption') {
        downloadCsv(
          `${filename}.csv`,
          ['Meter', 'Period', 'Energy (kWh)', 'Unit Price (INR)', 'Total Cost (INR)'],
          [[meter.name, rangeLabel, totalKwh.toFixed(2), general.unitPrice, (totalKwh * general.unitPrice).toFixed(2)]],
        );
      } else {
        downloadCsv(
          `${filename}.csv`,
          ['Timestamp', 'kWh', 'kVAh', 'kVArh', 'VRY', 'VYB', 'VBR', 'IR', 'IY', 'IB', 'PF-R', 'Frequency'],
          readings.map((r) => [
            formatDateTime(r.timestamp),
            r.kwh, r.kvah, r.kvarh, r.vry, r.vyb, r.vbr, r.ir, r.iy, r.ib, r.pfR, r.frequency,
          ]),
        );
      }
    } else {
      const body =
        reportType === 'consumption'
          ? `<h1>Consumption & Cost Report</h1><p class="sub">${meter.name} — ${rangeLabel}</p>
             <table><tbody>
               <tr><th>Total energy</th><td>${formatNumber(totalKwh, 2)} kWh</td></tr>
               <tr><th>Unit price</th><td>${formatCurrency(general.unitPrice)} per kWh</td></tr>
               <tr><th>Total cost</th><td>${formatCurrency(totalKwh * general.unitPrice)}</td></tr>
             </tbody></table>`
          : `<h1>${REPORT_TYPE_LABEL[reportType]}</h1><p class="sub">${meter.name} — ${rangeLabel}</p>
             <table><thead><tr><th>Time</th><th>kWh</th><th>VRY</th><th>IR</th><th>PF-R</th></tr></thead><tbody>
             ${readings.slice(0, 200).map((r) => `<tr><td>${formatDateTime(r.timestamp)}</td><td>${formatNumber(r.kwh, 2)}</td><td>${formatNumber(r.vry, 2)}</td><td>${formatNumber(r.ir, 2)}</td><td>${formatNumber(r.pfR, 3)}</td></tr>`).join('')}
             </tbody></table>`;
      downloadPdfStub(`${filename}.html`, REPORT_TYPE_LABEL[reportType], body);
    }

    toast('Report generated', {
      description: `${REPORT_TYPE_LABEL[reportType]} exported as ${format.toUpperCase()}.`,
    });
  }

  return (
    <>
      <PageHeader
        title="Enhanced Report Generator"
        icon={<FileText size={20} aria-hidden />}
        crumbs={[
          { label: 'Home', to: '/dashboard' },
          { label: 'Data & Logs' },
          { label: 'Reports' },
        ]}
      />

      {/* Report configuration summary */}
      <Card className="mb-5">
        <CardHeader
          icon={<Info size={15} className="text-brand-600" aria-hidden />}
          title="Report Configuration"
        />
        <CardBody>
          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <h3 className="mb-2 text-theme-xs font-semibold uppercase tracking-wide text-gray-500">
                Device Information
              </h3>
              <dl className="space-y-1.5">
                {[
                  ['Device Name', meter.name],
                  ['Device Type', device.meterType],
                  ['Customer', siteName(device.siteId)],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-baseline gap-3">
                    <dt className="w-32 shrink-0 text-theme-xs font-medium text-gray-600">
                      {label}:
                    </dt>
                    <dd className="text-theme-sm text-gray-800">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div>
              <h3 className="mb-2 text-theme-xs font-semibold uppercase tracking-wide text-brand-600">
                Current Settings
              </h3>
              <dl className="space-y-1.5">
                {[
                  ['Date Range', rangeLabel],
                  ['Report Type', REPORT_TYPE_LABEL[reportType]],
                  ['Unit Price', `${formatCurrency(general.unitPrice)} per kWh`],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-baseline gap-3">
                    <dt className="w-32 shrink-0 text-theme-xs font-medium text-gray-600">
                      {label}:
                    </dt>
                    <dd className="text-theme-sm text-gray-800">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Quick time range */}
      <Card className="mb-5">
        <CardHeader
          icon={<CalendarRange size={15} className="text-brand-600" aria-hidden />}
          title="Quick Time Range Selection"
        />
        <CardBody>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {RANGES.map((r) => (
              <RadioCard
                key={r.key}
                name="range"
                checked={range === r.key}
                onSelect={() => setRange(r.key)}
                icon={<CalendarDays size={14} className={r.iconClass} aria-hidden />}
                title={r.label}
              />
            ))}
          </div>

          {range === 'custom' ? (
            <div className="mt-4 grid gap-3 sm:max-w-md sm:grid-cols-2">
              <Field label="From" htmlFor="range-from">
                <TextInput
                  id="range-from"
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                />
              </Field>
              <Field label="To" htmlFor="range-to">
                <TextInput
                  id="range-to"
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                />
              </Field>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {/* Report type */}
      <Card className="mb-5">
        <CardHeader
          icon={<BarChart3 size={15} className="text-brand-600" aria-hidden />}
          title="Report Type Options"
          actions={
            reportType === 'consumption' ? (
              <Button variant="outline" size="sm" onClick={() => setPriceOpen(true)}>
                <IndianRupee size={13} aria-hidden />
                Configure Unit Price
              </Button>
            ) : null
          }
        />
        <CardBody>
          <div className="grid gap-3 sm:grid-cols-3">
            {REPORT_TYPES.map((rt) => (
              <RadioCard
                key={rt.key}
                name="reportType"
                checked={reportType === rt.key}
                onSelect={() => setReportType(rt.key)}
                icon={
                  rt.key === 'raw' ? (
                    <Table2 size={14} className="text-brand-500" aria-hidden />
                  ) : rt.key === 'analytical' ? (
                    <BarChart3 size={14} className="text-success-500" aria-hidden />
                  ) : (
                    <IndianRupee size={14} className="text-warning-500" aria-hidden />
                  )
                }
                title={rt.label}
                description={rt.description}
              />
            ))}
          </div>

          {reportType === 'consumption' ? (
            <div className="mt-4 rounded-lg border border-brand-200 bg-brand-25 px-3 py-2.5">
              <p className="text-theme-xs text-gray-700">
                Estimated cost for this period:{' '}
                <span className="font-semibold text-gray-900">
                  {formatCurrency(totalKwh * general.unitPrice)}
                </span>{' '}
                <span className="text-gray-500">
                  ({formatNumber(totalKwh, 2)} kWh × {formatCurrency(general.unitPrice)})
                </span>
              </p>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {/* Export format */}
      <Card>
        <CardHeader
          icon={<FileText size={15} className="text-brand-600" aria-hidden />}
          title="Export Format"
        />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                {
                  key: 'csv' as const,
                  icon: <FileSpreadsheet size={30} className="text-success-600" aria-hidden />,
                  title: 'Export to CSV',
                  description: 'Comma-separated values file',
                },
                {
                  key: 'pdf' as const,
                  icon: <FileText size={30} className="text-error-600" aria-hidden />,
                  title: 'Export to PDF',
                  description: 'Portable document format',
                },
              ]
            ).map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setFormat(option.key)}
                aria-pressed={format === option.key}
                className={cn(
                  'relative flex flex-col items-center rounded-lg border px-4 py-6 transition-colors',
                  format === option.key
                    ? 'border-success-400 bg-success-25 ring-1 ring-success-400'
                    : 'border-gray-200 hover:bg-gray-50',
                )}
              >
                {format === option.key ? (
                  <CheckCircle2
                    size={18}
                    className="absolute right-3 top-3 text-success-600"
                    aria-hidden
                  />
                ) : null}
                {option.icon}
                <span className="mt-2 text-theme-sm font-semibold text-gray-800">
                  {option.title}
                </span>
                <span className="mt-0.5 text-theme-xs text-gray-500">{option.description}</span>
              </button>
            ))}
          </div>

          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setRange('last30d');
                setReportType('raw');
                setFormat('csv');
              }}
            >
              Reset
            </Button>
            <Button onClick={generate}>Generate Report</Button>
          </div>
        </CardBody>
      </Card>

      <Modal
        open={priceOpen}
        onClose={() => setPriceOpen(false)}
        title="Configure Unit Price"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPriceOpen(false)}>
              Cancel
            </Button>
            <Button variant="success" onClick={applyPrice}>
              Apply Price
            </Button>
          </>
        }
      >
        <div className="flex items-start gap-2 rounded-lg border border-brand-200 bg-brand-25 px-3 py-2.5">
          <Info size={15} className="mt-0.5 shrink-0 text-brand-600" aria-hidden />
          <p className="text-theme-xs text-gray-700">
            This price will be used to calculate the total cost in your Consumption &amp; Cost
            report.
          </p>
        </div>

        <div className="mt-4">
          <Field
            label="Price per kWh"
            htmlFor="unit-price"
            unit="₹"
            error={priceError ?? undefined}
            hint={`Default: ${formatCurrency(8.5)} per unit`}
          >
            <div className="flex">
              <span className="flex w-10 items-center justify-center rounded-l-lg bg-brand-600 text-theme-sm font-semibold text-white">
                ₹
              </span>
              <input
                id="unit-price"
                inputMode="decimal"
                value={priceDraft}
                onChange={(e) => setPriceDraft(e.target.value)}
                className="w-full border-y border-gray-300 px-3 py-2 text-center text-theme-lg font-semibold tabular-nums text-gray-800 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
              <span className="flex items-center rounded-r-lg bg-brand-600 px-3 text-theme-xs font-semibold text-white">
                per kWh
              </span>
            </div>
          </Field>
        </div>
      </Modal>
    </>
  );
}
