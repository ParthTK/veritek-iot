import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Clock, Zap } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/States';
import { getDevice, listMeters } from '@/services';
import { useStore } from '@/hooks/useStore';
import { useDeviceSelection } from '@/hooks/useDeviceSelection';
import { formatDateTime, formatNumber } from '@/utils/format';

/**
 * The meter picker: one card per energy meter attached to the selected device,
 * showing cumulative kWh with kVAh / kVArh beneath, exactly as in the reference.
 */
export function EnergyMetersPage() {
  const { deviceId = '' } = useParams();
  useStore((s) => s.meters);
  const { selectDevice } = useDeviceSelection();

  const device = getDevice(deviceId);
  const meters = listMeters(deviceId);

  // Landing here directly (deep link / refresh) should still scope the sidebar.
  useEffect(() => {
    if (deviceId) selectDevice(deviceId);
  }, [deviceId, selectDevice]);

  return (
    <>
      <PageHeader
        title="Energy Meters"
        icon={<Zap size={20} aria-hidden />}
        backTo="/devices"
        crumbs={[
          { label: 'Home', to: '/dashboard' },
          { label: 'My Devices', to: '/devices' },
          { label: device?.name ?? 'Device' },
        ]}
        description={device ? `${device.deviceId} · ${device.location}` : undefined}
      />

      {meters.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<Zap size={36} strokeWidth={1.5} />}
            title="No meters on this device"
            description="This gateway has no energy meters mapped to it yet."
          />
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {meters.map((meter) => (
            <li key={meter.id}>
              <Link
                to={`/meters/${meter.id}/overview`}
                className="card block px-4 py-3.5 transition-colors hover:border-brand-400 hover:bg-brand-25"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-theme-xs font-medium uppercase tracking-wide text-gray-500">
                    {meter.name}
                  </p>
                  <Zap size={17} className="shrink-0 text-brand-400" aria-hidden />
                </div>

                <p className="mt-3 text-title-sm font-bold leading-none tabular-nums text-gray-900">
                  {formatNumber(meter.kwh, 2)}
                  <span className="ml-1.5 text-theme-sm font-medium text-gray-500">kWh</span>
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                  <p className="text-theme-xs text-gray-600">
                    <span className="font-semibold tabular-nums text-gray-800">
                      {formatNumber(meter.kvah, 2)}
                    </span>{' '}
                    kVAh
                  </p>
                  <p className="text-theme-xs text-gray-600">
                    <span className="font-semibold tabular-nums text-gray-800">
                      {formatNumber(meter.kvarh, 2)}
                    </span>{' '}
                    kVArh
                  </p>
                </div>

                <p className="mt-2 flex items-center gap-1.5 text-theme-2xs text-gray-400">
                  <Clock size={11} aria-hidden />
                  {formatDateTime(meter.lastReadingAt)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
