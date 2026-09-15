import { useState } from 'react';
import type { FormEvent } from 'react';
import { RotateCcw, ShieldCheck } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput, TextInput, Toggle } from '@/components/ui/Form';
import { getDevice, saveDevice } from '@/services';
import { useStore } from '@/hooks/useStore';
import { useToast } from '@/hooks/useToast';
import type { DeviceThresholds } from '@/types';

const DEFAULTS: DeviceThresholds = {
  voltageMin: 360,
  voltageMax: 440,
  currentMax: 160,
  powerMax: 95,
  energyMax: 5000,
  powerFactorMin: 0.85,
  frequencyMin: 49.5,
  frequencyMax: 50.5,
  warningPercent: 85,
  criticalPercent: 95,
  notificationsEnabled: true,
};

interface FieldSpec {
  key: keyof DeviceThresholds;
  label: string;
  unit?: string;
  step?: string;
}

const GROUPS: { title: string; fields: FieldSpec[] }[] = [
  {
    title: 'Voltage',
    fields: [
      { key: 'voltageMin', label: 'Minimum Voltage', unit: 'V' },
      { key: 'voltageMax', label: 'Maximum Voltage', unit: 'V' },
    ],
  },
  {
    title: 'Load',
    fields: [
      { key: 'currentMax', label: 'Maximum Current', unit: 'A' },
      { key: 'powerMax', label: 'Maximum Power', unit: 'kW' },
      { key: 'energyMax', label: 'Maximum Energy Usage', unit: 'kWh' },
    ],
  },
  {
    title: 'Quality',
    fields: [
      { key: 'powerFactorMin', label: 'Minimum Power Factor', step: '0.01' },
      { key: 'frequencyMin', label: 'Frequency Minimum', unit: 'Hz', step: '0.1' },
      { key: 'frequencyMax', label: 'Frequency Maximum', unit: 'Hz', step: '0.1' },
    ],
  },
  {
    title: 'Alerting bands',
    fields: [
      { key: 'warningPercent', label: 'Warning Threshold', unit: '% of limit' },
      { key: 'criticalPercent', label: 'Critical Threshold', unit: '% of limit' },
    ],
  },
];

/** Per-device threshold configuration with units beside every input. */
export function ThresholdsPage() {
  const devices = useStore((s) => s.devices);
  const { toast } = useToast();

  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? '');
  const device = getDevice(deviceId) ?? devices[0];
  const [draft, setDraft] = useState<DeviceThresholds>(device?.thresholds ?? DEFAULTS);
  const [lastId, setLastId] = useState(deviceId);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Re-seed the form when a different device is picked.
  if (deviceId !== lastId) {
    setLastId(deviceId);
    setDraft(getDevice(deviceId)?.thresholds ?? DEFAULTS);
    setErrors({});
  }

  function set(key: keyof DeviceThresholds, value: number | boolean) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (draft.voltageMin >= draft.voltageMax)
      next.voltageMin = 'Minimum voltage must be below the maximum.';
    if (draft.frequencyMin >= draft.frequencyMax)
      next.frequencyMin = 'Minimum frequency must be below the maximum.';
    if (draft.powerFactorMin <= 0 || draft.powerFactorMin > 1)
      next.powerFactorMin = 'Power factor must be between 0 and 1.';
    if (draft.warningPercent >= draft.criticalPercent)
      next.warningPercent = 'Warning threshold must be below the critical threshold.';

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    if (device) {
      saveDevice({ ...device, thresholds: draft });
      toast('Thresholds saved', { description: `Limits updated for ${device.name}.` });
    }
  }

  if (!device) return null;

  return (
    <>
      <PageHeader
        title="Threshold Configuration"
        icon={<ShieldCheck size={20} aria-hidden />}
        crumbs={[
          { label: 'Home', to: '/dashboard' },
          { label: 'Administration' },
          { label: 'Thresholds' },
        ]}
      />

      <form onSubmit={handleSubmit} noValidate>
        <Card className="mb-5">
          <CardBody className="pt-4">
            <div className="max-w-sm">
              <Field label="Device" htmlFor="th-device">
                <SelectInput
                  id="th-device"
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value)}
                >
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} — {d.deviceId}
                    </option>
                  ))}
                </SelectInput>
              </Field>
            </div>
          </CardBody>
        </Card>

        <div className="grid gap-5 xl:grid-cols-2">
          {GROUPS.map((group) => (
            <Card key={group.title}>
              <CardHeader title={group.title} />
              <CardBody>
                <div className="grid gap-4 sm:grid-cols-2">
                  {group.fields.map((f) => (
                    <Field
                      key={f.key}
                      label={f.label}
                      htmlFor={`th-${f.key}`}
                      unit={f.unit}
                      error={errors[f.key]}
                    >
                      <TextInput
                        id={`th-${f.key}`}
                        type="number"
                        step={f.step}
                        value={String(draft[f.key])}
                        onChange={(e) => set(f.key, Number(e.target.value))}
                        invalid={Boolean(errors[f.key])}
                      />
                    </Field>
                  ))}
                </div>
              </CardBody>
            </Card>
          ))}
        </div>

        <Card className="mt-5">
          <CardBody className="pt-4">
            <Toggle
              checked={draft.notificationsEnabled}
              onChange={(v) => set('notificationsEnabled', v)}
              label="Notifications enabled"
              description="Send alerts when any of the thresholds above is crossed"
            />
          </CardBody>
        </Card>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setDraft(DEFAULTS);
              setErrors({});
              toast('Thresholds reset to defaults', { variant: 'info' });
            }}
          >
            <RotateCcw size={14} aria-hidden />
            Reset to defaults
          </Button>
          <Button type="submit">Save thresholds</Button>
        </div>
      </form>
    </>
  );
}
