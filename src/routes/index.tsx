import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { LoginPage } from '@/pages/LoginPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { DeviceSelectionPage } from '@/pages/DeviceSelectionPage';
import { EnergyMetersPage } from '@/pages/EnergyMetersPage';
import { MeterDetailPage } from '@/pages/meter/MeterDetailPage';
import { OverviewTab } from '@/pages/meter/OverviewTab';
import { VoltageTab } from '@/pages/meter/VoltageTab';
import { CurrentTab } from '@/pages/meter/CurrentTab';
import { EnergyTab } from '@/pages/meter/EnergyTab';
import { DiagnosticTab } from '@/pages/meter/DiagnosticTab';
import { AlertSettingsTab } from '@/pages/meter/AlertSettingsTab';
import { DataChartsPage } from '@/pages/DataChartsPage';
import { DataLogsPage } from '@/pages/DataLogsPage';
import { ReportsPage } from '@/pages/ReportsPage';
import { AlertsPage } from '@/pages/AlertsPage';
import { DeviceManagementPage } from '@/pages/admin/DeviceManagementPage';
import { UsersPage } from '@/pages/admin/UsersPage';
import { ThresholdsPage } from '@/pages/admin/ThresholdsPage';
import { SettingsPage } from '@/pages/admin/SettingsPage';
import { ProfilePage } from '@/pages/ProfilePage';
import { NotFoundPage } from '@/pages/NotFoundPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<AppLayout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/devices" element={<DeviceSelectionPage />} />
        <Route path="/devices/:deviceId/meters" element={<EnergyMetersPage />} />

        <Route path="/meters/:meterId" element={<MeterDetailPage />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<OverviewTab />} />
          <Route path="voltage" element={<VoltageTab />} />
          <Route path="current" element={<CurrentTab />} />
          <Route path="energy" element={<EnergyTab />} />
          <Route path="diagnostic" element={<DiagnosticTab />} />
          <Route path="alerts" element={<AlertSettingsTab />} />
        </Route>

        <Route path="/data/charts" element={<DataChartsPage />} />
        <Route path="/data/logs" element={<DataLogsPage />} />
        <Route path="/data/reports" element={<ReportsPage />} />
        <Route path="/alerts" element={<AlertsPage />} />

        <Route path="/admin/devices" element={<DeviceManagementPage />} />
        <Route path="/admin/users" element={<UsersPage />} />
        <Route path="/admin/thresholds" element={<ThresholdsPage />} />
        <Route path="/admin/settings" element={<SettingsPage />} />
        <Route path="/profile" element={<ProfilePage />} />
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
