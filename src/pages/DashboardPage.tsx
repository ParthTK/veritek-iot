import { Link } from 'react-router-dom';
import { Activity, Bell, Cpu, Radio, Zap } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatCard } from '@/components/dashboard/GaugeCard';
import { listAlerts, listDevices } from '@/services';
import { useStore } from '@/hooks/useStore';

const QUICK_ACTIONS = [
  {
    to: '/devices',
    label: 'My Devices',
    description: 'View all devices',
    icon: Cpu,
    className: 'text-brand-600',
  },
  {
    to: '/alerts',
    label: 'Alerts',
    description: 'Manage alerts',
    icon: Bell,
    className: 'text-warning-500',
  },
  {
    to: '/data/logs',
    label: 'EMS Data',
    description: 'View live data',
    icon: Activity,
    className: 'text-success-600',
  },
];

export function DashboardPage() {
  // Subscribing keeps the counts live when devices are edited in admin.
  const devices = useStore((s) => s.devices);
  const alerts = useStore((s) => s.alerts);

  const total = devices.length;
  const online = devices.filter((d) => d.status === 'online').length;
  const activeAlerts = alerts.filter((a) => a.status === 'active').length;

  return (
    <>
      <PageHeader title="Dashboard" crumbs={[{ label: 'Home' }, { label: 'Dashboard' }]} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="Total Devices"
          value={total}
          sub="All time devices connected"
          icon={<Cpu size={38} strokeWidth={1.25} />}
        />
        <StatCard
          label="Online Devices"
          value={online}
          sub="Active in last 10 minutes"
          accent="success"
          icon={<Radio size={38} strokeWidth={1.25} />}
        />
        <StatCard
          label="Active Alerts"
          value={activeAlerts}
          sub="Awaiting acknowledgement"
          accent={activeAlerts > 0 ? 'error' : 'brand'}
          icon={<Bell size={38} strokeWidth={1.25} />}
        />
      </div>

      <h2 className="mb-3 mt-7 flex items-center gap-2 text-theme-lg font-semibold text-gray-800">
        <Zap size={17} className="text-brand-600" aria-hidden />
        Quick Actions
      </h2>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {QUICK_ACTIONS.map((action) => (
          <Link
            key={action.to}
            to={action.to}
            className="card flex flex-col items-center px-4 py-6 transition-colors hover:border-brand-300 hover:bg-brand-25"
          >
            <action.icon size={30} className={action.className} strokeWidth={1.75} aria-hidden />
            <p className="mt-2.5 text-theme-sm font-semibold text-gray-800">{action.label}</p>
            <p className="mt-0.5 text-theme-xs text-gray-500">{action.description}</p>
          </Link>
        ))}
      </div>

      <h2 className="mb-3 mt-7 text-theme-lg font-semibold text-gray-800">Recent Alerts</h2>
      <div className="card divide-y divide-gray-100">
        {listAlerts()
          .slice(0, 5)
          .map((alert) => {
            const device = listDevices().find((d) => d.id === alert.deviceId);
            return (
              <Link
                key={alert.id}
                to="/alerts"
                className="flex items-start justify-between gap-4 px-4 py-3 transition-colors hover:bg-gray-50"
              >
                <div className="min-w-0">
                  <p className="text-theme-sm font-medium text-gray-800">{alert.type}</p>
                  <p className="mt-0.5 truncate text-theme-xs text-gray-500">
                    {device?.name ?? 'Unknown device'} — {alert.message}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-theme-2xs font-medium ${
                    alert.severity === 'critical'
                      ? 'bg-error-50 text-error-700'
                      : alert.severity === 'warning'
                        ? 'bg-warning-50 text-warning-700'
                        : 'bg-brand-50 text-brand-700'
                  }`}
                >
                  {alert.severity}
                </span>
              </Link>
            );
          })}
      </div>
    </>
  );
}
