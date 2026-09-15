import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock, Cpu, MapPin, Radio, Search, SearchX } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { SelectInput, TextInput } from '@/components/ui/Form';
import { StatusPill } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/States';
import { listSites, siteName } from '@/services';
import { useStore } from '@/hooks/useStore';
import { useDeviceSelection } from '@/hooks/useDeviceSelection';
import { formatRelative } from '@/utils/format';
import { cn } from '@/utils/cn';

/**
 * "My Devices" — searchable, filterable list of device cards. Selecting a card
 * scopes the Data & Logs section and opens that device's meters.
 */
export function DeviceSelectionPage() {
  const devices = useStore((s) => s.devices);
  const navigate = useNavigate();
  const { deviceId, selectDevice } = useDeviceSelection();

  const [query, setQuery] = useState('');
  const [site, setSite] = useState('all');
  const [status, setStatus] = useState('all');
  const [pending, setPending] = useState<string | null>(deviceId);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return devices.filter((d) => {
      if (site !== 'all' && d.siteId !== site) return false;
      if (status !== 'all' && d.status !== status) return false;
      if (!q) return true;
      return (
        d.name.toLowerCase().includes(q) ||
        d.deviceId.toLowerCase().includes(q) ||
        d.serialNumber.toLowerCase().includes(q) ||
        siteName(d.siteId).toLowerCase().includes(q)
      );
    });
  }, [devices, query, site, status]);

  function open(id: string) {
    selectDevice(id);
    navigate(`/devices/${id}/meters`);
  }

  const hasFilters = query !== '' || site !== 'all' || status !== 'all';

  return (
    <>
      <PageHeader
        title="My Devices"
        icon={<Cpu size={20} aria-hidden />}
        crumbs={[{ label: 'Home', to: '/dashboard' }, { label: 'My Devices' }]}
        actions={
          pending ? (
            <Button onClick={() => open(pending)}>Open Dashboard</Button>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-[220px] flex-1">
          <label htmlFor="device-search" className="sr-only">
            Search devices
          </label>
          <TextInput
            id="device-search"
            type="search"
            placeholder="Search by name, device ID, serial or site…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            icon={<Search size={15} />}
          />
        </div>

        <label className="sr-only" htmlFor="site-filter">
          Filter by site
        </label>
        <SelectInput
          id="site-filter"
          value={site}
          onChange={(e) => setSite(e.target.value)}
          className="w-auto min-w-[160px]"
        >
          <option value="all">All locations</option>
          {listSites().map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectInput>

        <label className="sr-only" htmlFor="status-filter">
          Filter by status
        </label>
        <SelectInput
          id="status-filter"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="w-auto min-w-[140px]"
        >
          <option value="all">All statuses</option>
          <option value="online">Online</option>
          <option value="warning">Warning</option>
          <option value="offline">Offline</option>
        </SelectInput>

        {hasFilters ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery('');
              setSite('all');
              setStatus('all');
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      {filtered.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<SearchX size={36} strokeWidth={1.5} />}
            title="No devices found"
            description="No device matches the current search and filters. Try a different term or clear the filters."
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setQuery('');
                  setSite('all');
                  setStatus('all');
                }}
              >
                Clear filters
              </Button>
            }
          />
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((device) => {
            const isSelected = pending === device.id;
            return (
              <li key={device.id}>
                <article
                  className={cn(
                    'card h-full px-4 py-3.5 transition-colors',
                    isSelected ? 'border-brand-500 ring-1 ring-brand-500' : 'hover:border-gray-300',
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 text-theme-xs font-medium text-gray-700">
                        <MapPin size={13} className="shrink-0 text-gray-400" aria-hidden />
                        <span className="truncate">{device.deviceId}</span>
                      </p>
                      <p className="mt-1.5 text-theme-sm font-semibold text-gray-900">
                        {device.name}
                      </p>
                    </div>
                    <StatusPill status={device.status} />
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="rounded bg-success-50 px-1.5 py-0.5 text-theme-2xs font-medium text-success-700">
                      EMS
                    </span>
                    <span className="flex items-center gap-1 text-theme-xs text-gray-500">
                      <MapPin size={12} aria-hidden />
                      {siteName(device.siteId)}
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-gray-50 px-2.5 py-2 text-center">
                      <Radio size={15} className="mx-auto text-gray-500" aria-hidden />
                      <p className="mt-1 text-theme-2xs text-gray-500">Modem</p>
                      <p className="text-theme-sm font-semibold text-gray-800">
                        {device.modemCount}
                      </p>
                    </div>
                    <div className="rounded-lg bg-gray-50 px-2.5 py-2 text-center">
                      <Clock size={15} className="mx-auto text-success-600" aria-hidden />
                      <p className="mt-1 text-theme-2xs text-gray-500">Last Updated</p>
                      <p className="text-theme-xs font-semibold text-gray-800">
                        {formatRelative(device.lastSeen, Date.parse('2025-11-22T11:35:00+05:30'))}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPending(isSelected ? null : device.id)}
                      className="flex-1"
                    >
                      {isSelected ? 'Selected' : 'Select'}
                    </Button>
                    <Button size="sm" onClick={() => open(device.id)} className="flex-1">
                      View Details
                    </Button>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
