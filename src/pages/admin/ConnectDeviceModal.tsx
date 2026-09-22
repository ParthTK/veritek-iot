import { useEffect, useState } from 'react';
import { Check, Copy, KeyRound, TriangleAlert } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput, TextInput } from '@/components/ui/Form';
import { listSites, refreshLiveData } from '@/services';
import {
  fetchConnectionProfile,
  provisionDevice,
  revokeDevice,
  rotateDevicePassword,
  type ConnectionProfile,
  type ProvisionResult,
} from '@/services/api';
import type { Device } from '@/types';
import { useToast } from '@/hooks/useToast';

/**
 * Connect a real device.
 *
 * Registers it with the server, which issues its broker login and confines it
 * to its own topics, then shows the installer everything needed to configure
 * the hardware. The password is in exactly one response and is stored only as
 * a hash, so this is the one moment it can be read - hence the warning, the
 * copy buttons, and the rotation offered afterwards rather than a way back to
 * this screen.
 */

function CopyRow({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-start gap-2 border-b border-gray-100 py-2 last:border-0">
      <span className="w-32 shrink-0 pt-0.5 text-theme-2xs uppercase tracking-wide text-gray-500">{label}</span>
      <code
        className={
          'min-w-0 flex-1 break-all font-mono text-theme-xs ' + (secret ? 'text-error-700' : 'text-gray-800')
        }
      >
        {value}
      </code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => undefined,
          );
        }}
        className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-brand-600"
        aria-label={'Copy ' + label}
      >
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </button>
    </div>
  );
}

/** What a device has to publish for the platform to store its readings. */
function samplePayload(profile: ConnectionProfile): string {
  return JSON.stringify(
    {
      gateway_id: profile.username,
      slave_id: 1,
      timestamp: new Date().toISOString(),
      registers: {
        voltage_l1: 231.4,
        current_l1: 12.3,
        active_power_kw: 2.84,
        power_factor: 0.96,
        frequency_hz: 50.01,
        energy_import_kwh: 10234.5,
      },
    },
    null,
    2,
  );
}

export function ConnectDeviceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const sites = listSites();

  const [uid, setUid] = useState('');
  const [name, setName] = useState('');
  const [siteId, setSiteId] = useState(sites[0]?.id ?? '');
  const [slaves, setSlaves] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProvisionResult | null>(null);

  function reset() {
    setUid('');
    setName('');
    setSlaves('1');
    setError(null);
    setResult(null);
  }

  async function submit() {
    const slaveIds = slaves
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 247);

    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(uid)) {
      setError('Use letters, digits, hyphen or underscore — for example GW-MUM-001.');
      return;
    }
    if (slaveIds.length === 0) {
      setError('Give at least one Modbus slave id between 1 and 247.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const provisioned = await provisionDevice({
        gatewayUid: uid.trim(),
        name: name.trim() || uid.trim(),
        siteId: siteId || null,
        slaveIds,
      });
      setResult(provisioned);
      // Show it in the device list straight away, offline until it connects.
      void refreshLiveData();
      toast('Device connected', { description: uid, variant: 'success' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  const profile = result?.connection;

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={result ? 'Device connected' : 'Connect a device'}
      description={
        result
          ? 'Configure the hardware with these settings. The password is shown only now.'
          : 'Registers the device with the server and issues its own broker login, limited to its own topics.'
      }
      size="lg"
      footer={
        result ? (
          <Button
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Done
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} loading={busy}>
              <KeyRound size={15} aria-hidden />
              Connect device
            </Button>
          </>
        )
      }
    >
      {result && profile ? (
        <div className="space-y-4">
          <div className="flex gap-2 rounded-lg border border-warning-200 bg-warning-50 p-3">
            <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warning-600" aria-hidden />
            <p className="text-theme-xs text-warning-800">
              The password is stored only as a hash and cannot be shown again. Copy it into the device
              now. If it is lost, rotate the credential from the device list — the device keeps its
              identity and its history.
            </p>
          </div>

          <section>
            <h3 className="mb-1 text-theme-sm font-medium text-gray-800">Network</h3>
            <div className="rounded-lg border border-gray-200 px-3">
              <CopyRow label="Broker host" value={profile.host} />
              <CopyRow label="Port (TLS)" value={String(profile.tlsPort)} />
              {profile.plainPort ? (
                <CopyRow label="Port (plain)" value={String(profile.plainPort)} />
              ) : null}
              <CopyRow label="Username" value={profile.username} />
              <CopyRow label="Password" value={result.mqttPassword} secret />
              <CopyRow label="Client ID" value={profile.clientId} />
              <CopyRow label="QoS" value={String(profile.qos)} />
            </div>
          </section>

          <section>
            <h3 className="mb-1 text-theme-sm font-medium text-gray-800">Topics</h3>
            <p className="mb-1 text-theme-2xs text-gray-500">
              This device may publish only on these, and subscribe only to its command topic.
            </p>
            <div className="rounded-lg border border-gray-200 px-3">
              <CopyRow label="Telemetry" value={profile.telemetryTopic} />
              <CopyRow label="Status" value={profile.statusTopic} />
              <CopyRow label="Command" value={profile.commandTopic} />
              <CopyRow label="Response" value={profile.responseTopic} />
            </div>
          </section>

          <section>
            <h3 className="mb-1 text-theme-sm font-medium text-gray-800">Payload</h3>
            <p className="mb-1 text-theme-2xs text-gray-500">
              JSON on the telemetry topic. Send whichever measurements the meter reports; unknown
              keys are stored and can be mapped later.
            </p>
            <pre className="overflow-x-auto rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-theme-2xs text-gray-700">
              {samplePayload(profile)}
            </pre>
          </section>
        </div>
      ) : (
        <div className="space-y-4">
          <Field
            label="Device ID"
            htmlFor="connect-uid"
            required
            hint="Its name on the broker and in every topic. Often the serial or SIM number."
          >
            <TextInput
              id="connect-uid"
              value={uid}
              placeholder="GW-MUM-001"
              onChange={(e) => setUid(e.target.value)}
              autoFocus
            />
          </Field>

          <Field label="Display name" htmlFor="connect-name" hint="What it is called on the dashboard.">
            <TextInput
              id="connect-name"
              value={name}
              placeholder="Plant 1 — Main Incomer"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          <Field label="Site" htmlFor="connect-site">
            <SelectInput id="connect-site" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">Unassigned</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </SelectInput>
          </Field>

          <Field
            label="Modbus slave IDs"
            htmlFor="connect-slaves"
            required
            hint="One meter per id on the RS485 bus. Comma-separated, e.g. 1,2,3."
          >
            <TextInput
              id="connect-slaves"
              value={slaves}
              placeholder="1"
              onChange={(e) => setSlaves(e.target.value)}
            />
          </Field>

          {error ? (
            <p className="text-theme-xs text-error-600" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

/**
 * The connection sheet for a device already on the system.
 *
 * Everything except the password, which the server cannot produce again -
 * rotating issues a new one, and the device has to be updated with it.
 */
export function DeviceConnectionModal({
  device,
  open,
  onClose,
}: {
  device: Device | null;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [profile, setProfile] = useState<ConnectionProfile | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !device) return;
    setProfile(null);
    setPassword(null);
    setError(null);
    fetchConnectionProfile(device.id)
      .then((response) => setProfile(response.connection))
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Could not load the connection details.'),
      );
  }, [open, device]);

  async function rotate() {
    if (!device) return;
    setBusy(true);
    try {
      const { mqttPassword } = await rotateDevicePassword(device.id);
      setPassword(mqttPassword);
      toast('New password issued', { description: 'Update the device with it.', variant: 'warning' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not rotate the password.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!device) return;
    setBusy(true);
    try {
      await revokeDevice(device.id, 'Revoked from the dashboard');
      toast('Access revoked', { description: device.name + ' can no longer connect.', variant: 'warning' });
      void refreshLiveData();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not revoke access.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={device ? device.name : 'Device'}
      description="How this device reaches the broker, and what it is allowed to do there."
      size="lg"
      footer={
        <>
          <Button variant="danger" onClick={() => void revoke()} disabled={busy}>
            Revoke access
          </Button>
          <Button variant="outline" onClick={() => void rotate()} loading={busy}>
            <KeyRound size={15} aria-hidden />
            Rotate password
          </Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {error ? (
        <p className="mb-3 text-theme-xs text-error-600" role="alert">
          {error}
        </p>
      ) : null}

      {password ? (
        <div className="mb-4 rounded-lg border border-warning-200 bg-warning-50 p-3">
          <div className="mb-1 flex gap-2">
            <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warning-600" aria-hidden />
            <p className="text-theme-xs text-warning-800">
              New password, shown only now. The old one stops working as soon as the device
              reconnects.
            </p>
          </div>
          <CopyRow label="Password" value={password} secret />
        </div>
      ) : null}

      {profile ? (
        <div className="space-y-4">
          <section>
            <h3 className="mb-1 text-theme-sm font-medium text-gray-800">Network</h3>
            <div className="rounded-lg border border-gray-200 px-3">
              <CopyRow label="Broker host" value={profile.host} />
              <CopyRow label="Port (TLS)" value={String(profile.tlsPort)} />
              {profile.plainPort ? <CopyRow label="Port (plain)" value={String(profile.plainPort)} /> : null}
              <CopyRow label="Username" value={profile.username} />
              <CopyRow label="Client ID" value={profile.clientId} />
            </div>
          </section>
          <section>
            <h3 className="mb-1 text-theme-sm font-medium text-gray-800">Topics</h3>
            <div className="rounded-lg border border-gray-200 px-3">
              <CopyRow label="Telemetry" value={profile.telemetryTopic} />
              <CopyRow label="Status" value={profile.statusTopic} />
              <CopyRow label="Command" value={profile.commandTopic} />
              <CopyRow label="Response" value={profile.responseTopic} />
            </div>
          </section>
        </div>
      ) : (
        !error && <p className="text-theme-xs text-gray-500">Loading…</p>
      )}
    </Modal>
  );
}
