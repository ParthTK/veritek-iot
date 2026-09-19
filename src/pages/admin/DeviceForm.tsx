import { useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput, TextInput, Toggle } from '@/components/ui/Form';
import { Modal } from '@/components/ui/Modal';
import { createDeviceId, listSites, listUsers, saveDevice } from '@/services';
import { useToast } from '@/hooks/useToast';
import type { CommunicationMode, Device, MeterType } from '@/types';

const METER_TYPES: MeterType[] = [
  'Energy Monitoring System (EMS)',
  'Tri-Vector Meter',
  'CT Operated',
  'Sub-Meter',
];

const COMM_MODES: CommunicationMode[] = ['4G LTE', '2G GPRS', 'Ethernet', 'Wi-Fi', 'RS-485'];

function blankDevice(): Device {
  return {
    id: createDeviceId(),
    deviceId: '',
    name: '',
    serialNumber: '',
    siteId: listSites()[0]?.id ?? '',
    location: '',
    meterType: 'Energy Monitoring System (EMS)',
    communicationMode: '4G LTE',
    readingInterval: 5,
    status: 'online',
    active: true,
    installationDate: new Date().toISOString().slice(0, 10),
    lastSeen: new Date().toISOString(),
    modemCount: 1,
    assignedUserId: null,
    thresholds: {
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
    },
  };
}

interface DeviceFormProps {
  open: boolean;
  onClose: () => void;
  /** Null opens the form in "add" mode. */
  device: Device | null;
  readOnly?: boolean;
}

/** Add / edit / view form for a device, with required-field validation. */
export function DeviceForm({ open, onClose, device, readOnly = false }: DeviceFormProps) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<Device>(device ?? blankDevice());
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Re-seed the draft whenever a different device is opened.
  const [lastId, setLastId] = useState(device?.id ?? null);
  if ((device?.id ?? null) !== lastId) {
    setLastId(device?.id ?? null);
    setDraft(device ?? blankDevice());
    setErrors({});
  }

  function set<K extends keyof Device>(key: K, value: Device[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function setThreshold(key: keyof Device['thresholds'], value: number | boolean) {
    setDraft((prev) => ({ ...prev, thresholds: { ...prev.thresholds, [key]: value } }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!draft.name.trim()) next.name = 'Device name is required.';
    if (!draft.deviceId.trim()) next.deviceId = 'Device ID is required.';
    if (!draft.serialNumber.trim()) next.serialNumber = 'Serial number is required.';
    if (!draft.location.trim()) next.location = 'Location is required.';
    if (draft.readingInterval <= 0) next.readingInterval = 'Interval must be greater than zero.';
    if (draft.thresholds.voltageMin >= draft.thresholds.voltageMax)
      next.voltageMin = 'Minimum voltage must be below the maximum.';

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    saveDevice(draft);
    toast(device ? 'Device updated' : 'Device added', {
      description: `${draft.name} saved successfully.`,
    });
    onClose();
  }

  const title = readOnly ? 'Device Details' : device ? 'Edit Device' : 'Add Device';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="xl"
      footer={
        readOnly ? (
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSubmit}>Save Device</Button>
          </>
        )
      }
    >
      <form onSubmit={handleSubmit} noValidate>
        <fieldset disabled={readOnly} className="space-y-5">
          <div>
            <h3 className="mb-3 text-theme-xs font-semibold uppercase tracking-wide text-gray-500">
              Identification
            </h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Device Name" htmlFor="d-name" required error={errors.name}>
                <TextInput
                  id="d-name"
                  value={draft.name}
                  onChange={(e) => set('name', e.target.value)}
                  invalid={Boolean(errors.name)}
                />
              </Field>
              <Field label="Device ID" htmlFor="d-id" required error={errors.deviceId}>
                <TextInput
                  id="d-id"
                  value={draft.deviceId}
                  onChange={(e) => set('deviceId', e.target.value)}
                  placeholder="GW-ABC-0001"
                  invalid={Boolean(errors.deviceId)}
                />
              </Field>
              <Field
                label="Serial Number"
                htmlFor="d-serial"
                required
                error={errors.serialNumber}
              >
                <TextInput
                  id="d-serial"
                  value={draft.serialNumber}
                  onChange={(e) => set('serialNumber', e.target.value)}
                  placeholder="VTK-EMS-4410-0091"
                  invalid={Boolean(errors.serialNumber)}
                />
              </Field>
              <Field label="Meter Type" htmlFor="d-type">
                <SelectInput
                  id="d-type"
                  value={draft.meterType}
                  onChange={(e) => set('meterType', e.target.value as MeterType)}
                >
                  {METER_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <Field label="Site" htmlFor="d-site">
                <SelectInput
                  id="d-site"
                  value={draft.siteId}
                  onChange={(e) => set('siteId', e.target.value)}
                >
                  {listSites().map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <Field label="Location" htmlFor="d-location" required error={errors.location}>
                <TextInput
                  id="d-location"
                  value={draft.location}
                  onChange={(e) => set('location', e.target.value)}
                  placeholder="Plant 1 — HT Panel"
                  invalid={Boolean(errors.location)}
                />
              </Field>
            </div>
          </div>

          <div>
            <h3 className="mb-3 text-theme-xs font-semibold uppercase tracking-wide text-gray-500">
              Communication
            </h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Communication Mode" htmlFor="d-comm">
                <SelectInput
                  id="d-comm"
                  value={draft.communicationMode}
                  onChange={(e) => set('communicationMode', e.target.value as CommunicationMode)}
                >
                  {COMM_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <Field
                label="Reading Interval"
                htmlFor="d-interval"
                unit="minutes"
                error={errors.readingInterval}
              >
                <TextInput
                  id="d-interval"
                  type="number"
                  min={1}
                  value={draft.readingInterval}
                  onChange={(e) => set('readingInterval', Number(e.target.value))}
                  invalid={Boolean(errors.readingInterval)}
                />
              </Field>
              <Field label="Installation Date" htmlFor="d-install">
                <TextInput
                  id="d-install"
                  type="date"
                  value={draft.installationDate}
                  onChange={(e) => set('installationDate', e.target.value)}
                />
              </Field>
              <Field label="Assigned User" htmlFor="d-user">
                <SelectInput
                  id="d-user"
                  value={draft.assignedUserId ?? ''}
                  onChange={(e) => set('assignedUserId', e.target.value || null)}
                >
                  <option value="">Unassigned</option>
                  {listUsers().map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <Field label="Connection Status" htmlFor="d-status">
                <SelectInput
                  id="d-status"
                  value={draft.status}
                  onChange={(e) => set('status', e.target.value as Device['status'])}
                >
                  <option value="online">Online</option>
                  <option value="warning">Warning</option>
                  <option value="offline">Offline</option>
                </SelectInput>
              </Field>
              <div className="flex items-end pb-1">
                <Toggle
                  checked={draft.active}
                  onChange={(v) => set('active', v)}
                  label="Active"
                  description="Inactive devices stop polling"
                />
              </div>
            </div>
          </div>

          <div>
            <h3 className="mb-3 text-theme-xs font-semibold uppercase tracking-wide text-gray-500">
              Thresholds
            </h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field
                label="Voltage Minimum"
                htmlFor="d-vmin"
                unit="V"
                error={errors.voltageMin}
              >
                <TextInput
                  id="d-vmin"
                  type="number"
                  value={draft.thresholds.voltageMin}
                  onChange={(e) => setThreshold('voltageMin', Number(e.target.value))}
                  invalid={Boolean(errors.voltageMin)}
                />
              </Field>
              <Field label="Voltage Maximum" htmlFor="d-vmax" unit="V">
                <TextInput
                  id="d-vmax"
                  type="number"
                  value={draft.thresholds.voltageMax}
                  onChange={(e) => setThreshold('voltageMax', Number(e.target.value))}
                />
              </Field>
              <Field label="Current Maximum" htmlFor="d-imax" unit="A">
                <TextInput
                  id="d-imax"
                  type="number"
                  value={draft.thresholds.currentMax}
                  onChange={(e) => setThreshold('currentMax', Number(e.target.value))}
                />
              </Field>
              <Field label="Power Maximum" htmlFor="d-pmax" unit="kW">
                <TextInput
                  id="d-pmax"
                  type="number"
                  value={draft.thresholds.powerMax}
                  onChange={(e) => setThreshold('powerMax', Number(e.target.value))}
                />
              </Field>
              <Field label="Energy Maximum" htmlFor="d-emax" unit="kWh">
                <TextInput
                  id="d-emax"
                  type="number"
                  value={draft.thresholds.energyMax}
                  onChange={(e) => setThreshold('energyMax', Number(e.target.value))}
                />
              </Field>
              <Field label="Power Factor Minimum" htmlFor="d-pfmin">
                <TextInput
                  id="d-pfmin"
                  type="number"
                  step="0.01"
                  value={draft.thresholds.powerFactorMin}
                  onChange={(e) => setThreshold('powerFactorMin', Number(e.target.value))}
                />
              </Field>
              <Field label="Frequency Minimum" htmlFor="d-fmin" unit="Hz">
                <TextInput
                  id="d-fmin"
                  type="number"
                  step="0.1"
                  value={draft.thresholds.frequencyMin}
                  onChange={(e) => setThreshold('frequencyMin', Number(e.target.value))}
                />
              </Field>
              <Field label="Frequency Maximum" htmlFor="d-fmax" unit="Hz">
                <TextInput
                  id="d-fmax"
                  type="number"
                  step="0.1"
                  value={draft.thresholds.frequencyMax}
                  onChange={(e) => setThreshold('frequencyMax', Number(e.target.value))}
                />
              </Field>
            </div>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
