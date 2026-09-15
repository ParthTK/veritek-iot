import { useCallback, useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { Logo } from './Logo';
import { useAuth } from '@/hooks/useAuth';
import { getSelectedDeviceId, setSelectedDeviceId } from '@/services';
import { DeviceContext } from '@/hooks/useDeviceSelection';

/**
 * Authenticated shell: fixed left navigation, a compact mobile top bar, and a
 * padded content column. There is no desktop top header — in the reference the
 * account block and logout live at the foot of the sidebar.
 */
export function AppLayout() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const [deviceId, setDeviceIdState] = useState<string | null>(() => getSelectedDeviceId());

  const selectDevice = useCallback((id: string | null) => {
    setSelectedDeviceId(id);
    setDeviceIdState(id);
  }, []);

  // Reset scroll between pages so long tables do not open half-way down.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return (
    <DeviceContext.Provider value={{ deviceId, selectDevice }}>
      <div className="min-h-screen bg-gray-50">
        <Sidebar open={navOpen} onClose={() => setNavOpen(false)} selectedDeviceId={deviceId} />

        <div className="lg:pl-[236px]">
          {/* Mobile / tablet bar — the desktop layout has no top header. */}
          <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-2.5 lg:hidden">
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              className="rounded-lg border border-gray-200 p-1.5 text-gray-600 hover:bg-gray-50"
              aria-label="Open navigation"
            >
              <Menu size={18} aria-hidden />
            </button>
            <Logo height={24} />
          </header>

          <main className="mx-auto w-full max-w-[1600px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
            <Outlet />
          </main>
        </div>
      </div>
    </DeviceContext.Provider>
  );
}
