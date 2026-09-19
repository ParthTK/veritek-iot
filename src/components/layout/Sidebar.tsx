import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Bell,
  BarChart3,
  ChevronDown,
  Cpu,
  FileText,
  Gauge,
  LayoutDashboard,
  LogOut,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Table2,
  Users,
  X,
} from 'lucide-react';
import { Logo } from './Logo';
import { useAuth } from '@/hooks/useAuth';
import { getSite } from '@/services';
import { cn } from '@/utils/cn';

interface NavChild {
  to: string;
  label: string;
  icon: typeof Table2;
}

interface NavItem {
  to?: string;
  label: string;
  icon: typeof LayoutDashboard;
  children?: NavChild[];
  /** Only rendered once a device has been opened, as in the reference. */
  requiresDevice?: boolean;
}

const PRIMARY_NAV: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/devices', label: 'My Devices', icon: Cpu },
  {
    label: 'Data & Logs',
    icon: BarChart3,
    requiresDevice: true,
    children: [
      { to: '/data/charts', label: 'Charts', icon: Gauge },
      { to: '/data/logs', label: 'Logs', icon: Table2 },
      { to: '/data/reports', label: 'Reports', icon: FileText },
    ],
  },
  { to: '/alerts', label: 'Alerts', icon: Bell },
];

const ADMIN_NAV: NavItem[] = [
  { to: '/admin/devices', label: 'Device Management', icon: SlidersHorizontal },
  { to: '/admin/users', label: 'Users', icon: Users },
  { to: '/admin/thresholds', label: 'Thresholds', icon: ShieldCheck },
  { to: '/admin/settings', label: 'Settings', icon: Settings },
];

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  selectedDeviceId: string | null;
}

export function Sidebar({ open, onClose, selectedDeviceId }: SidebarProps) {
  const { user, signOut } = useAuth();
  const location = useLocation();
  const [dataOpen, setDataOpen] = useState(true);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const siteLabel = user?.assignedSites?.[0] ? getSite(user.assignedSites[0])?.name : null;

  return (
    <>
      {/* Mobile scrim */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-gray-900/40 transition-opacity lg:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={onClose}
        aria-hidden
      />

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-[236px] flex-col border-r border-gray-200 bg-white transition-transform lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-label="Main navigation"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3.5">
          <Logo />
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-500 hover:bg-gray-100 lg:hidden"
            aria-label="Close navigation"
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 custom-scrollbar">
          <ul className="space-y-1">
            {PRIMARY_NAV.map((item) => {
              if (item.requiresDevice && !selectedDeviceId) return null;

              if (item.children) {
                const childActive = item.children.some((c) =>
                  location.pathname.startsWith(c.to),
                );
                return (
                  <li key={item.label}>
                    <button
                      type="button"
                      onClick={() => setDataOpen((v) => !v)}
                      aria-expanded={dataOpen}
                      className={cn(
                        'menu-item group justify-between',
                        childActive ? 'menu-item-active' : 'menu-item-inactive',
                      )}
                    >
                      <span className="flex items-center gap-3">
                        <item.icon
                          size={18}
                          className={
                            childActive ? 'menu-item-icon-active' : 'menu-item-icon-inactive'
                          }
                          aria-hidden
                        />
                        {item.label}
                      </span>
                      <ChevronDown
                        size={15}
                        className={cn('transition-transform', dataOpen && 'rotate-180')}
                        aria-hidden
                      />
                    </button>
                    {dataOpen ? (
                      <ul className="mt-1 space-y-0.5 pl-4">
                        {item.children.map((child) => (
                          <li key={child.to}>
                            <NavLink
                              to={child.to}
                              className={({ isActive }) =>
                                cn(
                                  'menu-item group py-1.5 text-theme-xs',
                                  isActive ? 'menu-item-active' : 'menu-item-inactive',
                                )
                              }
                            >
                              {({ isActive }) => (
                                <>
                                  <child.icon
                                    size={15}
                                    className={
                                      isActive
                                        ? 'menu-item-icon-active'
                                        : 'menu-item-icon-inactive'
                                    }
                                    aria-hidden
                                  />
                                  {child.label}
                                </>
                              )}
                            </NavLink>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              }

              return (
                <li key={item.to}>
                  <NavLink
                    to={item.to!}
                    className={({ isActive }) =>
                      cn('menu-item group', isActive ? 'menu-item-active' : 'menu-item-inactive')
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <item.icon
                          size={18}
                          className={
                            isActive ? 'menu-item-icon-active' : 'menu-item-icon-inactive'
                          }
                          aria-hidden
                        />
                        {item.label}
                      </>
                    )}
                  </NavLink>
                </li>
              );
            })}
          </ul>

          <p className="mb-2 mt-6 px-3 text-theme-2xs font-semibold uppercase tracking-wide text-gray-400">
            Administration
          </p>
          <ul className="space-y-1">
            {ADMIN_NAV.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to!}
                  className={({ isActive }) =>
                    cn('menu-item group', isActive ? 'menu-item-active' : 'menu-item-inactive')
                  }
                >
                  {({ isActive }) => (
                    <>
                      <item.icon
                        size={18}
                        className={isActive ? 'menu-item-icon-active' : 'menu-item-icon-inactive'}
                        aria-hidden
                      />
                      {item.label}
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="border-t border-gray-200 px-3 py-3">
          <div className="mb-2 px-1">
            <p className="text-theme-xs font-semibold text-gray-800">{siteLabel ?? 'VERITEK'}</p>
            <p className="truncate text-theme-2xs text-gray-500">{user?.email}</p>
          </div>
          <button
            type="button"
            onClick={signOut}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-theme-sm font-medium text-white transition-colors hover:bg-brand-700"
          >
            <LogOut size={15} aria-hidden />
            Logout
          </button>
        </div>
      </aside>
    </>
  );
}
