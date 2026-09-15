import { useState } from 'react';
import type { FormEvent } from 'react';
import { Bell, Database, Settings as SettingsIcon, SlidersHorizontal, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput, TextInput, Toggle } from '@/components/ui/Form';
import { ConfirmDialog } from '@/components/ui/Modal';
import {
  getState,
  resetDemoData,
  setGeneral,
  setNotifications,
} from '@/services';
import { useStore } from '@/hooks/useStore';
import { useToast } from '@/hooks/useToast';
import type { GeneralSettings, NotificationSettings } from '@/types';
import { cn } from '@/utils/cn';

type TabKey = 'general' | 'notifications' | 'system';

const TABS: { key: TabKey; label: string; icon: typeof SettingsIcon }[] = [
  { key: 'general', label: 'General', icon: SettingsIcon },
  { key: 'notifications', label: 'Notifications', icon: Bell },
  { key: 'system', label: 'System', icon: Database },
];

const NOTIFICATION_TOGGLES: {
  key: keyof NotificationSettings;
  label: string;
  description: string;
}[] = [
  { key: 'emailNotifications', label: 'Email notifications', description: 'Send alert emails to the recipient below' },
  { key: 'smsNotifications', label: 'SMS notifications', description: 'Send critical alerts by SMS' },
  { key: 'systemAlerts', label: 'System alerts', description: 'Device connectivity and gateway health' },
  { key: 'warningAlerts', label: 'Warning alerts', description: 'Readings entering the warning band' },
  { key: 'criticalAlerts', label: 'Critical alerts', description: 'Readings crossing the critical threshold' },
  { key: 'dailySummary', label: 'Daily summary', description: 'One consumption digest each morning' },
  { key: 'weeklyReport', label: 'Weekly report', description: 'Consumption and cost report every Monday' },
];

/** Settings with General / Notifications / System sections. */
export function SettingsPage() {
  const general = useStore((s) => s.general);
  const notifications = useStore((s) => s.notifications);
  const { toast } = useToast();

  const [tab, setTab] = useState<TabKey>('general');
  const [generalDraft, setGeneralDraft] = useState<GeneralSettings>(general);
  const [notifDraft, setNotifDraft] = useState<NotificationSettings>(notifications);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [resetOpen, setResetOpen] = useState(false);

  function saveGeneral(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!generalDraft.organisationName.trim()) next.organisationName = 'Organisation name is required.';
    if (generalDraft.unitPrice <= 0) next.unitPrice = 'Unit price must be greater than zero.';
    if (generalDraft.rowsPerPage < 5) next.rowsPerPage = 'Use at least 5 rows per page.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setGeneral(generalDraft);
    toast('Settings saved', { description: 'General preferences updated.' });
  }

  function saveNotifications(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (
      notifDraft.emailNotifications &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notifDraft.recipientEmail.trim())
    )
      next.recipientEmail = 'Enter a valid recipient email address.';
    if (notifDraft.smsNotifications && notifDraft.recipientPhone.trim().length < 8)
      next.recipientPhone = 'Enter a valid recipient phone number.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setNotifications(notifDraft);
    toast('Notification settings saved');
  }

  return (
    <>
      <PageHeader
        title="Settings"
        icon={<SettingsIcon size={20} aria-hidden />}
        crumbs={[
          { label: 'Home', to: '/dashboard' },
          { label: 'Administration' },
          { label: 'Settings' },
        ]}
      />

      <nav className="mb-5 flex flex-wrap gap-1" aria-label="Settings sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            aria-current={tab === t.key ? 'page' : undefined}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-theme-sm font-medium transition-colors',
              tab === t.key
                ? 'bg-brand-600 text-white'
                : 'border border-gray-200 text-gray-600 hover:bg-gray-50',
            )}
          >
            <t.icon size={15} aria-hidden />
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'general' ? (
        <form onSubmit={saveGeneral}>
          <Card>
            <CardHeader
              icon={<SlidersHorizontal size={15} className="text-brand-600" aria-hidden />}
              title="General settings"
              description="Organisation defaults applied across the platform"
            />
            <CardBody>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <Field
                  label="Organisation Name"
                  htmlFor="s-org"
                  required
                  error={errors.organisationName}
                >
                  <TextInput
                    id="s-org"
                    value={generalDraft.organisationName}
                    onChange={(e) =>
                      setGeneralDraft({ ...generalDraft, organisationName: e.target.value })
                    }
                    invalid={Boolean(errors.organisationName)}
                  />
                </Field>
                <Field label="Timezone" htmlFor="s-tz">
                  <SelectInput
                    id="s-tz"
                    value={generalDraft.timezone}
                    onChange={(e) => setGeneralDraft({ ...generalDraft, timezone: e.target.value })}
                  >
                    <option>Asia/Kolkata (IST, UTC+05:30)</option>
                    <option>Asia/Dubai (GST, UTC+04:00)</option>
                    <option>UTC (UTC+00:00)</option>
                  </SelectInput>
                </Field>
                <Field label="Date Format" htmlFor="s-date">
                  <SelectInput
                    id="s-date"
                    value={generalDraft.dateFormat}
                    onChange={(e) =>
                      setGeneralDraft({ ...generalDraft, dateFormat: e.target.value })
                    }
                  >
                    <option>MM/DD/YYYY</option>
                    <option>DD/MM/YYYY</option>
                    <option>YYYY-MM-DD</option>
                  </SelectInput>
                </Field>
                <Field label="Currency" htmlFor="s-currency">
                  <SelectInput
                    id="s-currency"
                    value={generalDraft.currency}
                    onChange={(e) => setGeneralDraft({ ...generalDraft, currency: e.target.value })}
                  >
                    <option>INR (₹)</option>
                    <option>USD ($)</option>
                    <option>AED (د.إ)</option>
                  </SelectInput>
                </Field>
                <Field
                  label="Unit Price"
                  htmlFor="s-price"
                  unit="₹ per kWh"
                  error={errors.unitPrice}
                >
                  <TextInput
                    id="s-price"
                    type="number"
                    step="0.01"
                    value={generalDraft.unitPrice}
                    onChange={(e) =>
                      setGeneralDraft({ ...generalDraft, unitPrice: Number(e.target.value) })
                    }
                    invalid={Boolean(errors.unitPrice)}
                  />
                </Field>
                <Field label="Auto-refresh Interval" htmlFor="s-refresh" unit="seconds">
                  <TextInput
                    id="s-refresh"
                    type="number"
                    value={generalDraft.defaultRefreshSeconds}
                    onChange={(e) =>
                      setGeneralDraft({
                        ...generalDraft,
                        defaultRefreshSeconds: Number(e.target.value),
                      })
                    }
                  />
                </Field>
                <Field
                  label="Default Rows Per Page"
                  htmlFor="s-rows"
                  error={errors.rowsPerPage}
                >
                  <TextInput
                    id="s-rows"
                    type="number"
                    value={generalDraft.rowsPerPage}
                    onChange={(e) =>
                      setGeneralDraft({ ...generalDraft, rowsPerPage: Number(e.target.value) })
                    }
                    invalid={Boolean(errors.rowsPerPage)}
                  />
                </Field>
              </div>

              <div className="mt-5 flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setGeneralDraft(general)}>
                  Cancel
                </Button>
                <Button type="submit">Save changes</Button>
              </div>
            </CardBody>
          </Card>
        </form>
      ) : null}

      {tab === 'notifications' ? (
        <form onSubmit={saveNotifications}>
          <Card>
            <CardHeader
              icon={<Bell size={15} className="text-brand-600" aria-hidden />}
              title="Notification settings"
              description="Choose which events generate a notification and where they go"
            />
            <CardBody>
              <ul className="divide-y divide-gray-100">
                {NOTIFICATION_TOGGLES.map((item) => (
                  <li key={item.key} className="py-3">
                    <Toggle
                      checked={Boolean(notifDraft[item.key])}
                      onChange={(v) => setNotifDraft({ ...notifDraft, [item.key]: v })}
                      label={item.label}
                      description={item.description}
                    />
                  </li>
                ))}
              </ul>

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <Field
                  label="Recipient Email"
                  htmlFor="n-email"
                  error={errors.recipientEmail}
                >
                  <TextInput
                    id="n-email"
                    type="email"
                    value={notifDraft.recipientEmail}
                    onChange={(e) =>
                      setNotifDraft({ ...notifDraft, recipientEmail: e.target.value })
                    }
                    invalid={Boolean(errors.recipientEmail)}
                  />
                </Field>
                <Field
                  label="Recipient Phone"
                  htmlFor="n-phone"
                  error={errors.recipientPhone}
                >
                  <TextInput
                    id="n-phone"
                    value={notifDraft.recipientPhone}
                    onChange={(e) =>
                      setNotifDraft({ ...notifDraft, recipientPhone: e.target.value })
                    }
                    invalid={Boolean(errors.recipientPhone)}
                  />
                </Field>
              </div>

              <div className="mt-5 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setNotifDraft(notifications)}
                >
                  Cancel
                </Button>
                <Button type="submit">Save notification settings</Button>
              </div>
            </CardBody>
          </Card>
        </form>
      ) : null}

      {tab === 'system' ? (
        <Card>
          <CardHeader
            icon={<Database size={15} className="text-brand-600" aria-hidden />}
            title="System preferences"
            description="Demo data lives in this browser's localStorage"
          />
          <CardBody>
            <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {[
                ['Environment', 'Frontend demo (no backend)'],
                ['Data source', 'Local mock datasets'],
                ['Persistence', 'Browser localStorage'],
                ['Platform version', 'v1.0.0'],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-gray-200 px-3 py-2.5">
                  <dt className="text-theme-2xs uppercase tracking-wide text-gray-500">{label}</dt>
                  <dd className="mt-0.5 text-theme-sm text-gray-800">{value}</dd>
                </div>
              ))}
            </dl>

            <div className="mt-5 rounded-lg border border-error-200 bg-error-25 px-4 py-3.5">
              <h3 className="text-theme-sm font-semibold text-gray-800">Reset demo data</h3>
              <p className="mt-1 max-w-2xl text-theme-xs text-gray-600">
                Discards every local change — added or edited devices and users, acknowledged
                alerts, alert triggers and settings — and restores the shipped demo dataset.
              </p>
              <Button
                variant="danger"
                size="sm"
                className="mt-3"
                onClick={() => setResetOpen(true)}
              >
                <Trash2 size={14} aria-hidden />
                Reset demo data
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <ConfirmDialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        onConfirm={() => {
          resetDemoData();
          setGeneralDraft(getState().general);
          setNotifDraft(getState().notifications);
          toast('Demo data reset', { description: 'All local changes were discarded.', variant: 'info' });
        }}
        title="Reset all demo data?"
        message="Every local change will be discarded and the original demo dataset restored. This cannot be undone."
        confirmLabel="Reset everything"
      />
    </>
  );
}
