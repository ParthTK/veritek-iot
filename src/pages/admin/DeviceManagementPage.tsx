import { useMemo, useState } from 'react';
import { Eye, Pencil, Plus, Radio, Search, SlidersHorizontal, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardBody, CardFooter } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SelectInput, TextInput, Toggle } from '@/components/ui/Form';
import { DataTable } from '@/components/tables/DataTable';
import type { Column } from '@/components/tables/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { ConfirmDialog } from '@/components/ui/Modal';
import { Badge, StatusPill } from '@/components/ui/Badge';
import { DeviceForm } from './DeviceForm';
import { ConnectDeviceModal, DeviceConnectionModal } from './ConnectDeviceModal';
import {
  deleteDevice,
  getUser,
  isLiveDevice,
  listMeters,
  listSites,
  siteName,
  toggleDeviceActive,
} from '@/services';
import { useStore } from '@/hooks/useStore';
import { useToast } from '@/hooks/useToast';
import type { Device } from '@/types';
import { formatDateOnly, formatNumber } from '@/utils/format';

/** Device management: searchable table with add / edit / view / delete flows. */
export function DeviceManagementPage() {
  const devices = useStore((s) => s.devices);
  const { toast } = useToast();

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [site, setSite] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Device | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Device | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connection, setConnection] = useState<Device | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return devices.filter((d) => {
      if (status !== 'all' && d.status !== status) return false;
      if (site !== 'all' && d.siteId !== site) return false;
      if (!q) return true;
      return (
        d.name.toLowerCase().includes(q) ||
        d.deviceId.toLowerCase().includes(q) ||
        d.serialNumber.toLowerCase().includes(q) ||
        d.location.toLowerCase().includes(q)
      );
    });
  }, [devices, query, status, site]);

  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

  function openAdd() {
    setEditing(null);
    setReadOnly(false);
    setFormOpen(true);
  }

  function openEdit(device: Device) {
    setEditing(device);
    setReadOnly(false);
    setFormOpen(true);
  }

  function openView(device: Device) {
    setEditing(device);
    setReadOnly(true);
    setFormOpen(true);
  }

  const columns: Column<Device>[] = [
    {
      key: 'name',
      header: 'Device Name',
      sticky: true,
      sortValue: (d) => d.name,
      className: 'bg-white',
      render: (d) => (
        <div>
          <div className="flex items-center gap-1.5">
            <p className="font-medium text-gray-800">{d.name}</p>
            {isLiveDevice(d.id) ? <Badge tone="success">Live</Badge> : null}
          </div>
          <p className="text-theme-2xs text-gray-500">{d.deviceId}</p>
        </div>
      ),
    },
    { key: 'serialNumber', header: 'Serial Number', sortValue: (d) => d.serialNumber },
    {
      key: 'site',
      header: 'Site / Location',
      sortValue: (d) => siteName(d.siteId),
      render: (d) => (
        <div>
          <p className="text-gray-800">{siteName(d.siteId)}</p>
          <p className="text-theme-2xs text-gray-500">{d.location}</p>
        </div>
      ),
    },
    { key: 'meterType', header: 'Meter Type', sortValue: (d) => d.meterType },
    {
      key: 'status',
      header: 'Connection',
      sortValue: (d) => d.status,
      render: (d) => <StatusPill status={d.status} />,
    },
    {
      key: 'installationDate',
      header: 'Installed',
      sortValue: (d) => Date.parse(d.installationDate),
      render: (d) => formatDateOnly(d.installationDate),
    },
    {
      key: 'lastReading',
      header: 'Last Reading',
      align: 'right',
      render: (d) => {
        const meters = listMeters(d.id);
        const total = meters.reduce((sum, m) => sum + m.kwh, 0);
        return meters.length > 0 ? `${formatNumber(total, 2)} kWh` : '—';
      },
    },
    {
      key: 'assignedUser',
      header: 'Assigned User',
      sortValue: (d) => getUser(d.assignedUserId ?? '')?.name ?? '',
      render: (d) => getUser(d.assignedUserId ?? '')?.name ?? <span className="text-gray-400">Unassigned</span>,
    },
    {
      key: 'active',
      header: 'Status',
      render: (d) => (
        <div className="flex items-center gap-2">
          <Toggle
            checked={d.active}
            onChange={() => {
              toggleDeviceActive(d.id);
              toast(d.active ? 'Device disabled' : 'Device enabled', {
                description: d.name,
                variant: d.active ? 'warning' : 'success',
              });
            }}
            label={`${d.active ? 'Disable' : 'Enable'} ${d.name}`}
            hideLabel
          />
          <Badge tone={d.active ? 'success' : 'neutral'}>{d.active ? 'Active' : 'Inactive'}</Badge>
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (d) => (
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => openView(d)}
            className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-brand-600"
            aria-label={`View ${d.name}`}
          >
            <Eye size={15} aria-hidden />
          </button>
          {isLiveDevice(d.id) ? (
            // A real device is the server's record: its credentials are managed
            // from the connection sheet, not edited or deleted like demo data.
            <button
              type="button"
              onClick={() => setConnection(d)}
              className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-brand-600"
              aria-label={`Connection details for ${d.name}`}
            >
              <Radio size={15} aria-hidden />
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => openEdit(d)}
                className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-brand-600"
                aria-label={`Edit ${d.name}`}
              >
                <Pencil size={15} aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => setPendingDelete(d)}
                className="rounded p-1.5 text-gray-500 hover:bg-error-50 hover:text-error-600"
                aria-label={`Delete ${d.name}`}
              >
                <Trash2 size={15} aria-hidden />
              </button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Device Management"
        icon={<SlidersHorizontal size={20} aria-hidden />}
        crumbs={[
          { label: 'Home', to: '/dashboard' },
          { label: 'Administration' },
          { label: 'Devices' },
        ]}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={openAdd}>
              <Plus size={15} aria-hidden />
              Add demo device
            </Button>
            <Button onClick={() => setConnectOpen(true)}>
              <Radio size={15} aria-hidden />
              Connect a device
            </Button>
          </div>
        }
      />

      <Card className="mb-4">
        <CardBody className="pt-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <label htmlFor="dev-search" className="field-label">
                Search
              </label>
              <TextInput
                id="dev-search"
                type="search"
                placeholder="Name, device ID, serial or location…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
                icon={<Search size={15} />}
              />
            </div>
            <div>
              <label htmlFor="dev-status" className="field-label">
                Status
              </label>
              <SelectInput
                id="dev-status"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
                className="min-w-[140px]"
              >
                <option value="all">All statuses</option>
                <option value="online">Online</option>
                <option value="warning">Warning</option>
                <option value="offline">Offline</option>
              </SelectInput>
            </div>
            <div>
              <label htmlFor="dev-site" className="field-label">
                Location
              </label>
              <SelectInput
                id="dev-site"
                value={site}
                onChange={(e) => {
                  setSite(e.target.value);
                  setPage(1);
                }}
                className="min-w-[170px]"
              >
                <option value="all">All locations</option>
                {listSites().map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </SelectInput>
            </div>
            {(query || status !== 'all' || site !== 'all') && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQuery('');
                  setStatus('all');
                  setSite('all');
                  setPage(1);
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <DataTable
          columns={columns}
          rows={paged}
          rowKey={(d) => d.id}
          emptyTitle="No devices found"
          emptyDescription="No device matches the current search and filters."
          emptyAction={
            <Button variant="outline" onClick={() => { setQuery(''); setStatus('all'); setSite('all'); }}>
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

      <ConnectDeviceModal open={connectOpen} onClose={() => setConnectOpen(false)} />

      <DeviceConnectionModal
        device={connection}
        open={connection !== null}
        onClose={() => setConnection(null)}
      />

      <DeviceForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        device={editing}
        readOnly={readOnly}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            deleteDevice(pendingDelete.id);
            toast('Device deleted', {
              description: `${pendingDelete.name} was removed from the demo data.`,
              variant: 'info',
            });
          }
        }}
        title="Delete device?"
        message={
          pendingDelete
            ? `"${pendingDelete.name}" and its meters will be removed. This only affects local demo data and can be restored with "Reset demo data".`
            : ''
        }
        confirmLabel="Delete device"
      />
    </>
  );
}
