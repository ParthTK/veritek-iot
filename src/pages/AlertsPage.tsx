import { useMemo, useState } from 'react';
import { Bell, Check, CheckCheck, MoreHorizontal, Search } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardFooter } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SelectInput, TextInput } from '@/components/ui/Form';
import { DataTable } from '@/components/tables/DataTable';
import type { Column } from '@/components/tables/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { Modal } from '@/components/ui/Modal';
import { AlertStatusBadge, SeverityBadge } from '@/components/ui/Badge';
import { getDevice, listAlerts, setAlertStatus, siteName } from '@/services';
import { useStore } from '@/hooks/useStore';
import { useToast } from '@/hooks/useToast';
import type { Alert, AlertSeverity } from '@/types';
import { formatDateTime, formatNumber } from '@/utils/format';
import { cn } from '@/utils/cn';

type TabKey = 'all' | 'active' | 'resolved';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'all', label: 'All Alerts' },
  { key: 'active', label: 'Active' },
  { key: 'resolved', label: 'Resolved' },
];

/** Alerts management with tabs, filters, row actions and a detail modal. */
export function AlertsPage() {
  useStore((s) => s.alerts);
  const { toast } = useToast();

  const [tab, setTab] = useState<TabKey>('all');
  const [severity, setSeverity] = useState<'all' | AlertSeverity>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [detail, setDetail] = useState<Alert | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const alerts = listAlerts();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return alerts.filter((a) => {
      if (tab === 'active' && a.status === 'resolved') return false;
      if (tab === 'resolved' && a.status !== 'resolved') return false;
      if (severity !== 'all' && a.severity !== severity) return false;
      if (!q) return true;
      const device = getDevice(a.deviceId);
      return (
        a.type.toLowerCase().includes(q) ||
        a.message.toLowerCase().includes(q) ||
        a.metric.toLowerCase().includes(q) ||
        (device?.name ?? '').toLowerCase().includes(q)
      );
    });
  }, [alerts, tab, severity, query]);

  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

  const counts = {
    all: alerts.length,
    active: alerts.filter((a) => a.status !== 'resolved').length,
    resolved: alerts.filter((a) => a.status === 'resolved').length,
  };

  function acknowledge(alert: Alert) {
    setAlertStatus(alert.id, 'acknowledged');
    setMenuFor(null);
    toast('Alert acknowledged', { description: `${alert.type} on ${getDevice(alert.deviceId)?.name}` });
  }

  function resolve(alert: Alert) {
    setAlertStatus(alert.id, 'resolved');
    setMenuFor(null);
    toast('Alert resolved', { description: `${alert.type} marked as resolved.` });
  }

  const columns: Column<Alert>[] = [
    {
      key: 'timestamp',
      header: 'Timestamp',
      sortValue: (a) => Date.parse(a.timestamp),
      render: (a) => <span className="text-gray-700">{formatDateTime(a.timestamp)}</span>,
    },
    {
      key: 'device',
      header: 'Device',
      sortValue: (a) => getDevice(a.deviceId)?.name ?? '',
      render: (a) => {
        const device = getDevice(a.deviceId);
        return (
          <div>
            <p className="font-medium text-gray-800">{device?.name ?? '—'}</p>
            <p className="text-theme-2xs text-gray-500">{siteName(device?.siteId ?? '')}</p>
          </div>
        );
      },
    },
    { key: 'type', header: 'Alert Type', sortValue: (a) => a.type },
    {
      key: 'value',
      header: 'Value',
      align: 'right',
      sortValue: (a) => a.value,
      render: (a) => (
        <span className="font-semibold text-gray-800">
          {formatNumber(a.value, 2)} {a.unit}
        </span>
      ),
    },
    {
      key: 'threshold',
      header: 'Threshold',
      align: 'right',
      sortValue: (a) => a.threshold,
      render: (a) => `${formatNumber(a.threshold, 2)} ${a.unit}`,
    },
    {
      key: 'severity',
      header: 'Severity',
      sortValue: (a) => a.severity,
      render: (a) => <SeverityBadge severity={a.severity} />,
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (a) => a.status,
      render: (a) => <AlertStatusBadge status={a.status} />,
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (a) => (
        <div className="relative flex items-center justify-end gap-1">
          {a.status === 'active' ? (
            <Button variant="outline" size="sm" onClick={() => acknowledge(a)}>
              <Check size={13} aria-hidden />
              Acknowledge
            </Button>
          ) : null}
          {a.status !== 'resolved' ? (
            <Button variant="outline" size="sm" onClick={() => resolve(a)}>
              <CheckCheck size={13} aria-hidden />
              Resolve
            </Button>
          ) : null}
          <button
            type="button"
            onClick={() => setMenuFor(menuFor === a.id ? null : a.id)}
            className="rounded p-1.5 text-gray-500 hover:bg-gray-100"
            aria-label={`Actions for ${a.type}`}
            aria-expanded={menuFor === a.id}
          >
            <MoreHorizontal size={15} aria-hidden />
          </button>
          {menuFor === a.id ? (
            <div className="absolute right-0 top-8 z-20 w-40 rounded-lg border border-gray-200 bg-white py-1 shadow-theme-lg">
              <button
                type="button"
                onClick={() => {
                  setDetail(a);
                  setMenuFor(null);
                }}
                className="block w-full px-3 py-1.5 text-left text-theme-xs text-gray-700 hover:bg-gray-50"
              >
                View details
              </button>
              {a.status !== 'active' ? (
                <button
                  type="button"
                  onClick={() => {
                    setAlertStatus(a.id, 'active');
                    setMenuFor(null);
                    toast('Alert reopened', { variant: 'warning' });
                  }}
                  className="block w-full px-3 py-1.5 text-left text-theme-xs text-gray-700 hover:bg-gray-50"
                >
                  Reopen alert
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Alerts"
        icon={<Bell size={20} aria-hidden />}
        crumbs={[{ label: 'Home', to: '/dashboard' }, { label: 'Alerts' }]}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Alert status" className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => {
                setTab(t.key);
                setPage(1);
              }}
              className={cn(
                'rounded-lg px-3 py-1.5 text-theme-sm font-medium transition-colors',
                tab === t.key
                  ? 'bg-brand-600 text-white'
                  : 'border border-gray-200 text-gray-600 hover:bg-gray-50',
              )}
            >
              {t.label}
              <span className={cn('ml-1.5', tab === t.key ? 'text-white/70' : 'text-gray-400')}>
                {counts[t.key]}
              </span>
            </button>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-3">
          <div className="min-w-[200px]">
            <label htmlFor="alert-search" className="sr-only">
              Search alerts
            </label>
            <TextInput
              id="alert-search"
              type="search"
              placeholder="Search alerts…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
              icon={<Search size={15} />}
            />
          </div>
          <label htmlFor="alert-severity" className="sr-only">
            Filter by severity
          </label>
          <SelectInput
            id="alert-severity"
            value={severity}
            onChange={(e) => {
              setSeverity(e.target.value as typeof severity);
              setPage(1);
            }}
            className="w-auto min-w-[130px]"
          >
            <option value="all">All severities</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </SelectInput>
        </div>
      </div>

      <Card>
        <DataTable
          columns={columns}
          rows={paged}
          rowKey={(a) => a.id}
          emptyTitle="No alerts found"
          emptyDescription="No alert matches the current tab and filters."
          emptyAction={
            <Button
              variant="outline"
              onClick={() => {
                setTab('all');
                setSeverity('all');
                setQuery('');
              }}
            >
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

      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail?.type ?? 'Alert'}
        description={detail ? formatDateTime(detail.timestamp) : undefined}
        footer={
          detail ? (
            <>
              <Button variant="outline" onClick={() => setDetail(null)}>
                Close
              </Button>
              {detail.status === 'active' ? (
                <Button
                  onClick={() => {
                    acknowledge(detail);
                    setDetail(null);
                  }}
                >
                  Acknowledge
                </Button>
              ) : null}
              {detail.status !== 'resolved' ? (
                <Button
                  variant="success"
                  onClick={() => {
                    resolve(detail);
                    setDetail(null);
                  }}
                >
                  Resolve
                </Button>
              ) : null}
            </>
          ) : null
        }
      >
        {detail ? (
          <>
            <p className="text-theme-sm text-gray-600">{detail.message}</p>
            <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3">
              {[
                ['Device', getDevice(detail.deviceId)?.name ?? '—'],
                ['Location', siteName(getDevice(detail.deviceId)?.siteId ?? '')],
                ['Metric', detail.metric],
                ['Measured value', `${formatNumber(detail.value, 2)} ${detail.unit}`],
                ['Threshold', `${formatNumber(detail.threshold, 2)} ${detail.unit}`],
                ['Acknowledged', detail.acknowledgedAt ? formatDateTime(detail.acknowledgedAt) : '—'],
                ['Resolved', detail.resolvedAt ? formatDateTime(detail.resolvedAt) : '—'],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-theme-2xs uppercase tracking-wide text-gray-500">{label}</dt>
                  <dd className="mt-0.5 text-theme-sm text-gray-800">{value}</dd>
                </div>
              ))}
              <div>
                <dt className="text-theme-2xs uppercase tracking-wide text-gray-500">Severity</dt>
                <dd className="mt-1">
                  <SeverityBadge severity={detail.severity} />
                </dd>
              </div>
              <div>
                <dt className="text-theme-2xs uppercase tracking-wide text-gray-500">Status</dt>
                <dd className="mt-1">
                  <AlertStatusBadge status={detail.status} />
                </dd>
              </div>
            </dl>
          </>
        ) : null}
      </Modal>
    </>
  );
}
