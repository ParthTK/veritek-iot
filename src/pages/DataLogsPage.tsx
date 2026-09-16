import { useMemo, useState } from 'react';
import { Download, Search, Table2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardBody, CardFooter } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SelectInput, TextInput } from '@/components/ui/Form';
import { Pagination } from '@/components/ui/Pagination';
import { DataTable } from '@/components/tables/DataTable';
import type { Column } from '@/components/tables/DataTable';
import { EmptyState } from '@/components/ui/States';
import { Badge } from '@/components/ui/Badge';
import {
  getDevice,
  listMeters,
  listReadings,
  siteName,
} from '@/services';
import { useDeviceSelection } from '@/hooks/useDeviceSelection';
import { useStore, useStoreVersion } from '@/hooks/useStore';
import type { Reading } from '@/types';
import { formatDateTime, formatNumber, toInputDate } from '@/utils/format';
import { downloadCsv, downloadPdfStub } from '@/utils/csv';
import { useToast } from '@/hooks/useToast';

/**
 * Meter Data Logs — the dense sortable table from the reference, with the
 * date-range, device, metric and search filters the brief requires.
 *
 * Numeric colour coding follows the capture: kWh blue, VRY red, VYB amber.
 */
export function DataLogsPage() {
  const { deviceId } = useDeviceSelection();
  useStore((s) => s.meters);
  const { toast } = useToast();

  const device = deviceId ? getDevice(deviceId) : undefined;
  const dataVersion = useStoreVersion();
  const meters = useMemo(() => listMeters(deviceId ?? undefined), [deviceId, dataVersion]);

  const [meterId, setMeterId] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [metricGroup, setMetricGroup] = useState<'all' | 'energy' | 'voltage' | 'current' | 'pf'>(
    'all',
  );
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);

  const allRows = useMemo(() => {
    const source = meterId === 'all' ? meters : meters.filter((m) => m.id === meterId);
    return source
      .flatMap((m) => listReadings(m.id))
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  }, [meters, meterId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const fromTs = from ? Date.parse(`${from}T00:00:00`) : null;
    const toTs = to ? Date.parse(`${to}T23:59:59`) : null;

    return allRows.filter((r) => {
      const t = Date.parse(r.timestamp);
      if (fromTs !== null && t < fromTs) return false;
      if (toTs !== null && t > toTs) return false;
      if (!q) return true;
      const meterName = meters.find((m) => m.id === r.meterId)?.name ?? '';
      return (
        meterName.toLowerCase().includes(q) ||
        formatDateTime(r.timestamp).toLowerCase().includes(q) ||
        String(r.kwh).includes(q)
      );
    });
  }, [allRows, query, from, to, meters]);

  const paged = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize],
  );

  const meterName = (id: string) => meters.find((m) => m.id === id)?.name ?? '—';

  const energyColumns: Column<Reading>[] = [
    {
      key: 'kwh',
      header: 'kWh',
      align: 'right',
      sortValue: (r) => r.kwh,
      className: 'font-semibold text-brand-600',
      render: (r) => formatNumber(r.kwh, 2),
    },
    {
      key: 'kvah',
      header: 'kVAh',
      align: 'right',
      sortValue: (r) => r.kvah,
      render: (r) => formatNumber(r.kvah, 2),
    },
    {
      key: 'kvarh',
      header: 'kVArh',
      align: 'right',
      sortValue: (r) => r.kvarh,
      render: (r) => formatNumber(r.kvarh, 2),
    },
  ];

  const voltageColumns: Column<Reading>[] = [
    { key: 'vrn', header: 'VRN (V)', align: 'right', sortValue: (r) => r.vrn, render: (r) => formatNumber(r.vrn, 2) },
    { key: 'vyn', header: 'VYN (V)', align: 'right', sortValue: (r) => r.vyn, render: (r) => formatNumber(r.vyn, 2) },
    { key: 'vbn', header: 'VBN (V)', align: 'right', sortValue: (r) => r.vbn, render: (r) => formatNumber(r.vbn, 2) },
    {
      key: 'vry',
      header: 'VRY (V)',
      align: 'right',
      sortValue: (r) => r.vry,
      className: 'font-semibold text-phase-r',
      render: (r) => formatNumber(r.vry, 2),
    },
    {
      key: 'vyb',
      header: 'VYB (V)',
      align: 'right',
      sortValue: (r) => r.vyb,
      className: 'font-semibold text-phase-y',
      render: (r) => formatNumber(r.vyb, 2),
    },
    {
      key: 'vbr',
      header: 'VBR (V)',
      align: 'right',
      sortValue: (r) => r.vbr,
      className: 'font-semibold text-phase-b',
      render: (r) => formatNumber(r.vbr, 2),
    },
  ];

  const currentColumns: Column<Reading>[] = [
    { key: 'ir', header: 'IR (A)', align: 'right', sortValue: (r) => r.ir, render: (r) => formatNumber(r.ir, 2) },
    { key: 'iy', header: 'IY (A)', align: 'right', sortValue: (r) => r.iy, render: (r) => formatNumber(r.iy, 2) },
    { key: 'ib', header: 'IB (A)', align: 'right', sortValue: (r) => r.ib, render: (r) => formatNumber(r.ib, 2) },
  ];

  const pfColumns: Column<Reading>[] = [
    { key: 'pfR', header: 'PF-R', align: 'right', sortValue: (r) => r.pfR, render: (r) => formatNumber(r.pfR, 3) },
    { key: 'pfY', header: 'PF-Y', align: 'right', sortValue: (r) => r.pfY, render: (r) => formatNumber(r.pfY, 3) },
    { key: 'pfB', header: 'PF-B', align: 'right', sortValue: (r) => r.pfB, render: (r) => formatNumber(r.pfB, 3) },
    {
      key: 'frequency',
      header: 'Freq (Hz)',
      align: 'right',
      sortValue: (r) => r.frequency,
      render: (r) => formatNumber(r.frequency, 2),
    },
  ];

  const baseColumns: Column<Reading>[] = [
    {
      key: 'timestamp',
      header: 'Time',
      sticky: true,
      sortValue: (r) => Date.parse(r.timestamp),
      className: 'bg-white font-medium text-gray-700',
      render: (r) => formatDateTime(r.timestamp),
    },
    {
      key: 'device',
      header: 'Device',
      sortValue: (r) => meterName(r.meterId),
      render: (r) => <span className="font-medium text-gray-800">{meterName(r.meterId)}</span>,
    },
    {
      key: 'location',
      header: 'Location',
      sortValue: (r) => siteName(getDevice(r.deviceId)?.siteId ?? ''),
      render: (r) => siteName(getDevice(r.deviceId)?.siteId ?? ''),
    },
  ];

  const statusColumn: Column<Reading> = {
    key: 'status',
    header: 'Status',
    render: (r) => {
      const d = getDevice(r.deviceId);
      const high = d ? r.vry > d.thresholds.voltageMax : false;
      const lowPf = d ? r.pfR < d.thresholds.powerFactorMin : false;
      if (high) return <Badge tone="error">High voltage</Badge>;
      if (lowPf) return <Badge tone="warning">Low PF</Badge>;
      return <Badge tone="success">Normal</Badge>;
    },
  };

  const columns = useMemo(() => {
    const groups: Record<string, Column<Reading>[]> = {
      all: [...energyColumns, ...voltageColumns, ...currentColumns, ...pfColumns],
      energy: energyColumns,
      voltage: voltageColumns,
      current: currentColumns,
      pf: pfColumns,
    };
    return [...baseColumns, ...groups[metricGroup], statusColumn];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metricGroup, meters]);

  const hasFilters = query !== '' || from !== '' || to !== '' || meterId !== 'all' || metricGroup !== 'all';

  function clearFilters() {
    setQuery('');
    setFrom('');
    setTo('');
    setMeterId('all');
    setMetricGroup('all');
    setPage(1);
  }

  function exportCsv() {
    downloadCsv(
      `meter-data-logs-${toInputDate(new Date().toISOString())}.csv`,
      ['Timestamp', 'Device', 'Location', 'kWh', 'kVAh', 'kVArh', 'VRN', 'VYN', 'VBN', 'VRY', 'VYB', 'VBR', 'IR', 'IY', 'IB', 'PF-R', 'PF-Y', 'PF-B', 'Frequency'],
      filtered.map((r) => [
        formatDateTime(r.timestamp),
        meterName(r.meterId),
        siteName(getDevice(r.deviceId)?.siteId ?? ''),
        r.kwh, r.kvah, r.kvarh, r.vrn, r.vyn, r.vbn, r.vry, r.vyb, r.vbr,
        r.ir, r.iy, r.ib, r.pfR, r.pfY, r.pfB, r.frequency,
      ]),
    );
    toast('CSV exported', { description: `${filtered.length} rows written to file.` });
  }

  function exportPdf() {
    const rows = filtered
      .slice(0, 200)
      .map(
        (r) =>
          `<tr><td>${formatDateTime(r.timestamp)}</td><td>${meterName(r.meterId)}</td><td>${formatNumber(r.kwh, 2)}</td><td>${formatNumber(r.vry, 2)}</td><td>${formatNumber(r.ir, 2)}</td><td>${formatNumber(r.pfR, 3)}</td></tr>`,
      )
      .join('');
    downloadPdfStub(
      'meter-data-logs.html',
      'Meter Data Logs',
      `<h1>Meter Data Logs</h1><p class="sub">${device?.name ?? 'All devices'} — first 200 of ${filtered.length} rows</p>
       <table><thead><tr><th>Time</th><th>Device</th><th>kWh</th><th>VRY (V)</th><th>IR (A)</th><th>PF-R</th></tr></thead><tbody>${rows}</tbody></table>`,
    );
    toast('PDF export prepared', {
      description: 'A printable document was downloaded. Use your browser to save it as PDF.',
      variant: 'info',
    });
  }

  if (!deviceId) {
    return (
      <>
        <PageHeader title="Meter Data Logs" icon={<Table2 size={20} aria-hidden />} />
        <Card>
          <EmptyState
            icon={<Table2 size={36} strokeWidth={1.5} />}
            title="No device selected"
            description="Choose a device from My Devices to browse its reading history."
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Meter Data Logs"
        icon={<Table2 size={20} aria-hidden />}
        crumbs={[
          { label: 'Home', to: '/dashboard' },
          { label: 'Data & Logs' },
          { label: 'Logs' },
        ]}
        lastUpdated={allRows[0]?.timestamp}
        description={device ? `${device.name} · ${device.deviceId}` : undefined}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={exportCsv}>
              <Download size={14} aria-hidden />
              CSV
            </Button>
            <Button variant="outline" size="sm" onClick={exportPdf}>
              <Download size={14} aria-hidden />
              PDF
            </Button>
          </>
        }
      />

      <Card className="mb-4">
        <CardBody className="pt-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <div className="xl:col-span-2">
              <label htmlFor="log-search" className="field-label">
                Search
              </label>
              <TextInput
                id="log-search"
                type="search"
                placeholder="Meter, timestamp or value…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
                icon={<Search size={15} />}
              />
            </div>

            <div>
              <label htmlFor="log-meter" className="field-label">
                Meter
              </label>
              <SelectInput
                id="log-meter"
                value={meterId}
                onChange={(e) => {
                  setMeterId(e.target.value);
                  setPage(1);
                }}
              >
                <option value="all">All meters</option>
                {meters.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </SelectInput>
            </div>

            <div>
              <label htmlFor="log-metric" className="field-label">
                Metric group
              </label>
              <SelectInput
                id="log-metric"
                value={metricGroup}
                onChange={(e) => setMetricGroup(e.target.value as typeof metricGroup)}
              >
                <option value="all">All metrics</option>
                <option value="energy">Energy</option>
                <option value="voltage">Voltage</option>
                <option value="current">Current</option>
                <option value="pf">Power factor & frequency</option>
              </SelectInput>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="log-from" className="field-label">
                  From
                </label>
                <TextInput
                  id="log-from"
                  type="date"
                  value={from}
                  onChange={(e) => {
                    setFrom(e.target.value);
                    setPage(1);
                  }}
                />
              </div>
              <div>
                <label htmlFor="log-to" className="field-label">
                  To
                </label>
                <TextInput
                  id="log-to"
                  type="date"
                  value={to}
                  onChange={(e) => {
                    setTo(e.target.value);
                    setPage(1);
                  }}
                />
              </div>
            </div>
          </div>

          {hasFilters ? (
            <div className="mt-3 flex items-center gap-3">
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
              <p className="text-theme-xs text-gray-500">
                {filtered.length.toLocaleString('en-IN')} matching readings
              </p>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <DataTable
          columns={columns}
          rows={paged}
          rowKey={(r) => r.id}
          dense
          emptyTitle="No readings found"
          emptyDescription="No reading matches the current filters. Try widening the date range."
          emptyAction={
            <Button variant="outline" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
        {filtered.length > 0 ? (
          <CardFooter>
            <Pagination
              page={page}
              pageSize={pageSize}
              total={filtered.length}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          </CardFooter>
        ) : null}
      </Card>
    </>
  );
}
