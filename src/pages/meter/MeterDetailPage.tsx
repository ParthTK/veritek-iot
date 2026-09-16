import { useEffect, useMemo } from 'react';
import { NavLink, Outlet, useLocation, useOutletContext, useParams } from 'react-router-dom';
import { Activity, Bell, BarChart3, Home, Power, Zap } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/States';
import { getDevice, getMeter, listReadings } from '@/services';
import type { Meter, Reading } from '@/types';
import { useDeviceSelection } from '@/hooks/useDeviceSelection';
import { cn } from '@/utils/cn';
import { useStoreVersion } from '@/hooks/useStore';

export interface MeterContext {
  meter: Meter;
  readings: Reading[];
  deviceName: string;
}

const TABS = [
  { to: 'overview', label: 'Overview', icon: Home },
  { to: 'voltage', label: 'Voltage', icon: Zap },
  { to: 'current', label: 'Current', icon: Activity },
  { to: 'energy', label: 'Energy', icon: Zap },
  { to: 'diagnostic', label: 'Diagnostic', icon: Power },
  { to: 'alerts', label: 'Alerts', icon: Bell },
];

/** Convenience accessor for the six tab components. */
export function useMeterContext(): MeterContext {
  return useOutletContext<MeterContext>();
}

export function MeterDetailPage() {
  const { meterId = '' } = useParams();
  const location = useLocation();
  const { selectDevice } = useDeviceSelection();

  const meter = getMeter(meterId);
  const dataVersion = useStoreVersion();
  const readings = useMemo(() => (meter ? listReadings(meter.id) : []), [meter, dataVersion]);

  useEffect(() => {
    if (meter) selectDevice(meter.deviceId);
  }, [meter, selectDevice]);

  if (!meter) {
    return (
      <div className="card">
        <EmptyState
          icon={<BarChart3 size={36} strokeWidth={1.5} />}
          title="Meter not found"
          description="This meter is no longer available. Pick another from My Devices."
        />
      </div>
    );
  }

  const device = getDevice(meter.deviceId);
  const activeTab = TABS.find((t) => location.pathname.endsWith(`/${t.to}`));
  const ActiveIcon = activeTab?.icon ?? Home;

  const title =
    activeTab && activeTab.to !== 'overview'
      ? `${meter.name} - ${activeTab.to === 'alerts' ? 'Alert Settings' : activeTab.label}`
      : meter.name;

  return (
    <>
      <PageHeader
        title={title}
        icon={<ActiveIcon size={20} aria-hidden />}
        backTo={`/devices/${meter.deviceId}/meters`}
        crumbs={[
          { label: 'Home', to: '/dashboard' },
          { label: 'My Devices', to: '/devices' },
          { label: device?.name ?? 'Device', to: `/devices/${meter.deviceId}/meters` },
          { label: meter.name },
        ]}
        lastUpdated={meter.lastReadingAt}
      />

      {/* Pill tab bar */}
      <nav className="mb-5 overflow-x-auto no-scrollbar" aria-label="Meter views">
        <ul className="flex min-w-max items-center gap-1 border-b border-gray-200 pb-2">
          {TABS.map((tab) => (
            <li key={tab.to}>
              <NavLink
                to={tab.to}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-theme-sm font-medium transition-colors',
                    isActive
                      ? 'bg-brand-600 text-white'
                      : 'text-gray-600 hover:bg-gray-100 hover:text-gray-800',
                  )
                }
              >
                <tab.icon size={15} aria-hidden />
                {tab.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <Outlet
        context={
          { meter, readings, deviceName: device?.name ?? '—' } satisfies MeterContext
        }
      />
    </>
  );
}
