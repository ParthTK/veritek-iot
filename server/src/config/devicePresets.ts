import type { ProfileInput } from '../db/repositories/profiles.js';

/** Kept local so the topic layer can read presets without a circular import. */
type TopicKind = 'telemetry' | 'status' | 'command' | 'response';

/**
 * Known gateway models, and what it takes to talk to each one.
 *
 * Adding hardware should be adding an entry here - or, better, a payload
 * profile row and a topic override through the API - never a change to the
 * consumer, the normaliser or the storage layer. A preset carries the two
 * things a vendor actually dictates:
 *
 *   topics  - the ones whose firmware will not let us choose. Anything absent
 *             falls back to our own convention, which is what we ask a device
 *             to use wherever it can.
 *   profile - where the gateway id, the timestamp and the measurements live
 *             inside its JSON, and what its key names mean.
 *
 * `{gatewayUid}` in a topic is substituted with the device's id.
 */

export interface DevicePreset {
  id: string;
  label: string;
  /** Shown to whoever is commissioning the device. */
  summary: string;
  /** Topics the firmware fixes. Omitted kinds use our convention. */
  topics?: Partial<Record<TopicKind, string>>;
  /** Payload profile to create and pin to the gateway. */
  profile?: ProfileInput;
  /** Anything the installer has to know that the platform cannot enforce. */
  commissioningNotes?: string[];
}

/**
 * Technode TIG-5 variable names.
 *
 * The installer chooses these when configuring each Modbus transaction
 * (`SET MB CONFIG#...`, nine characters), so this is a starting set of the
 * conventional ones for an energy meter, not a fixed schema. Anything it does
 * not cover still arrives, is stored, and can be mapped from the commissioning
 * screen - matching ignores case and punctuation, so `V_RN` and `vrn` both hit
 * the `VRN` entry.
 */
const TIG5_KEY_MAP: Record<string, string> = {
  VRN: 'voltage_l1', VYN: 'voltage_l2', VBN: 'voltage_l3',
  V1: 'voltage_l1', V2: 'voltage_l2', V3: 'voltage_l3',
  VL1: 'voltage_l1', VL2: 'voltage_l2', VL3: 'voltage_l3',
  VRY: 'voltage_l12', VYB: 'voltage_l23', VBR: 'voltage_l31',
  VAVG: 'voltage_avg',
  IR: 'current_l1', IY: 'current_l2', IB: 'current_l3',
  I1: 'current_l1', I2: 'current_l2', I3: 'current_l3',
  IAVG: 'current_avg', IN: 'current_neutral',
  KW: 'active_power_kw', KVAR: 'reactive_power_kvar', KVA: 'apparent_power_kva',
  PF: 'power_factor', FREQ: 'frequency_hz', HZ: 'frequency_hz',
  KWH: 'energy_import_kwh', IMPKWH: 'energy_import_kwh', EXPKWH: 'energy_export_kwh',
  KVAH: 'apparent_energy_kvah', KVARH: 'reactive_energy_kvarh',
};

export const DEVICE_PRESETS: DevicePreset[] = [
  {
    id: 'generic',
    label: 'Generic MQTT device',
    summary: 'Publishes on our topics in our JSON. Use this unless the hardware cannot.',
  },
  {
    id: 'technode-tig5',
    label: 'Technode TIG-5 (4G Modbus gateway)',
    summary:
      'Data topic pointed at our namespace; its connection, command and response topics are ' +
      'fixed in firmware and granted as they are.',
    topics: {
      // Configurable on the device: SET DATA TOPIC#... - so it publishes
      // readings on our namespace, where the broker ties the topic to the
      // credential and the payload cannot claim to be another device.
      telemetry: 'energy/v1/gateways/{gatewayUid}/telemetry',
      // These three the firmware fixes. Granted exactly, and nothing wider.
      status: '{gatewayUid}/connection',
      command: '{gatewayUid}/cmd',
      response: '{gatewayUid}/cmd-res',
    },
    profile: {
      name: 'technode_tig5_v1',
      vendor: 'veritek',
      version: 1,
      // Pinned to the gateways that use it rather than matched by shape, so it
      // can never capture another vendor's packet.
      enabled: false,
      priority: 20,
      verified: false,
      matchRules: {},
      spec: {
        gatewayIdPaths: ['ID'],
        timestampPaths: ['TS'],
        timestampFormat: 'epoch_s',
        measurementPaths: ['data'],
        // No slave id anywhere in the packet: every transaction's value lands
        // in one flat `data` object. With several meters on the bus, name the
        // variables `VRN_1`, `VRN_2` and set meterKeyPattern below.
        slaveIdPaths: [],
        keyMap: TIG5_KEY_MAP,
        passthroughUnmapped: true,
      },
      notes:
        'Technode TIG-5. Payload: {"ID","Status","Signal","Location","data":{...},"TS","DT"}. ' +
        'TS is epoch seconds as a string. The keys inside `data` are the variable names set ' +
        'per Modbus transaction, so the key map is a starting point - check it against a real ' +
        'packet on the commissioning screen. For more than one meter on the RS485 bus, suffix ' +
        'the variable names with the slave id and set meterKeyPattern to ' +
        '^(?<metric>.+)_(?<slave>\\d+)$.',
    },
    commissioningNotes: [
      'SET MQTT CONFIG#<broker host>,8883,<username>,<password> - via SMS or the command topic.',
      'SET DATA TOPIC#energy/v1/gateways/<device id>/telemetry',
      'SET GATEWAY CONFIG#<location>,<apn>,<upload seconds>,1,1,0 - the two 1s are RTC calibration and offline buffering; leave both on.',
      'Confirm the unit does TLS on 8883. The manual names the port but documents no CA upload; if it cannot, it must stay on 1883 and that port is plaintext.',
      'The device publishes its own IMEI as "ID". Provision it under that IMEI so the two agree.',
    ],
  },
];

export function devicePreset(id: string | null | undefined): DevicePreset | null {
  if (!id) return null;
  return DEVICE_PRESETS.find((preset) => preset.id === id) ?? null;
}
