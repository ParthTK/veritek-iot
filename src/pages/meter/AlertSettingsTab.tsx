import { useState } from 'react';
import type { FormEvent } from 'react';
import { BellOff, Settings, Trash2 } from 'lucide-react';
import { useMeterContext } from './MeterDetailPage';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput, TextInput, Toggle } from '@/components/ui/Form';
import { EmptyState } from '@/components/ui/States';
import { ConfirmDialog } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { deleteTrigger, listTriggers, saveTrigger } from '@/services';
import { useStore } from '@/hooks/useStore';
import { useToast } from '@/hooks/useToast';
import type { TriggerCondition } from '@/types';
import { formatDateTime } from '@/utils/format';

/** Metric options, grouped exactly as in the reference's opened select. */
const METRIC_GROUPS = [
  {
    label: 'Current',
    options: [
      { value: 'I_R', label: 'I_R (Current R)' },
      { value: 'I_Y', label: 'I_Y (Current Y)' },
      { value: 'I_B', label: 'I_B (Current B)' },
    ],
  },
  {
    label: 'Power',
    options: [
      { value: 'KW_R', label: 'KW_R (Power R)' },
      { value: 'KW_Y', label: 'KW_Y (Power Y)' },
      { value: 'KW_B', label: 'KW_B (Power B)' },
    ],
  },
  {
    label: 'Power Factor',
    options: [
      { value: 'PF_R', label: 'PF_R (Power Factor R)' },
      { value: 'PF_Y', label: 'PF_Y (Power Factor Y)' },
      { value: 'PF_B', label: 'PF_B (Power Factor B)' },
    ],
  },
  {
    label: 'Other',
    options: [
      { value: 'FREQUENCY', label: 'Frequency' },
      { value: 'KWH', label: 'kWh (Energy)' },
      { value: 'KVAH', label: 'kVAh' },
      { value: 'KVARH', label: 'kVArh' },
    ],
  },
];

function labelForMetric(value: string): string {
  for (const group of METRIC_GROUPS) {
    const found = group.options.find((o) => o.value === value);
    if (found) return found.label;
  }
  return value;
}

/**
 * Alert Settings: the "Create Alert Trigger" form under its blue banner, with
 * the configured-triggers list (empty state included) below it.
 */
export function AlertSettingsTab() {
  const { meter } = useMeterContext();
  const { toast } = useToast();
  useStore((s) => s.triggers);

  const [metric, setMetric] = useState('');
  const [condition, setCondition] = useState<TriggerCondition>('above');
  const [threshold, setThreshold] = useState('');
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const triggers = listTriggers(meter.id);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!metric) next.metric = 'Select a metric to monitor.';
    if (threshold.trim() === '') next.threshold = 'Enter a threshold value.';
    else if (Number.isNaN(Number(threshold))) next.threshold = 'Threshold must be a number.';
    if (emailEnabled && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      next.email = 'Enter a valid email address.';

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    saveTrigger({
      id: `trg-${Date.now().toString(36)}`,
      meterId: meter.id,
      metric,
      metricLabel: labelForMetric(metric),
      condition,
      threshold: Number(threshold),
      emailEnabled,
      email: email.trim(),
      createdAt: new Date().toISOString(),
    });

    setMetric('');
    setThreshold('');
    setEmail('');
    setEmailEnabled(false);
    toast('Alert trigger created', {
      description: `${labelForMetric(metric)} ${condition === 'above' ? 'above' : 'below'} ${threshold}`,
    });
  }

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 bg-brand-600 px-4 py-2.5">
          <Settings size={15} className="text-white" aria-hidden />
          <h2 className="text-theme-sm font-semibold text-white">Create Alert Trigger</h2>
        </div>

        <form onSubmit={handleSubmit} noValidate className="px-4 py-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Metric" htmlFor="metric" required error={errors.metric}>
              <SelectInput
                id="metric"
                value={metric}
                onChange={(e) => setMetric(e.target.value)}
                invalid={Boolean(errors.metric)}
              >
                <option value="">Select Metric</option>
                {METRIC_GROUPS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </SelectInput>
            </Field>

            <Field label="Condition" htmlFor="condition" required>
              <SelectInput
                id="condition"
                value={condition}
                onChange={(e) => setCondition(e.target.value as TriggerCondition)}
              >
                <option value="above">Above Threshold</option>
                <option value="below">Below Threshold</option>
              </SelectInput>
            </Field>

            <Field
              label="Threshold Value"
              htmlFor="threshold"
              required
              error={errors.threshold}
            >
              <TextInput
                id="threshold"
                inputMode="decimal"
                placeholder="e.g. 440.5"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                invalid={Boolean(errors.threshold)}
              />
            </Field>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <div className="md:col-span-1">
              <Toggle
                checked={emailEnabled}
                onChange={setEmailEnabled}
                label="Email Notification"
                description="Send an email when this trigger fires"
              />
            </div>
            <Field
              label="Email Address"
              htmlFor="trigger-email"
              error={errors.email}
              className="md:col-span-2"
            >
              <TextInput
                id="trigger-email"
                type="email"
                placeholder="alerts@abc.example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={!emailEnabled}
                invalid={Boolean(errors.email)}
              />
            </Field>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setMetric('');
                setThreshold('');
                setEmail('');
                setEmailEnabled(false);
                setErrors({});
              }}
            >
              Reset
            </Button>
            <Button type="submit">Create Trigger</Button>
          </div>
        </form>
      </Card>

      <Card>
        {triggers.length === 0 ? (
          <EmptyState
            icon={<BellOff size={36} strokeWidth={1.5} />}
            title="No Triggers Configured"
            description="Create your first alert trigger using the form above."
          />
        ) : (
          <ul className="divide-y divide-gray-100">
            {triggers.map((trigger) => (
              <li key={trigger.id} className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-theme-sm font-medium text-gray-800">
                      {trigger.metricLabel}
                    </p>
                    <Badge tone={trigger.condition === 'above' ? 'error' : 'warning'}>
                      {trigger.condition === 'above' ? 'Above' : 'Below'} {trigger.threshold}
                    </Badge>
                    {trigger.emailEnabled ? <Badge tone="info">Email on</Badge> : null}
                  </div>
                  <p className="mt-0.5 text-theme-xs text-gray-500">
                    Created {formatDateTime(trigger.createdAt)}
                    {trigger.emailEnabled ? ` · notifies ${trigger.email}` : ''}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPendingDelete(trigger.id)}
                  aria-label={`Delete trigger for ${trigger.metricLabel}`}
                >
                  <Trash2 size={14} aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) deleteTrigger(pendingDelete);
          toast('Trigger deleted', { variant: 'info' });
        }}
        title="Delete alert trigger?"
        message="This trigger will stop monitoring the selected metric. This only affects local demo data."
        confirmLabel="Delete"
      />
    </div>
  );
}
