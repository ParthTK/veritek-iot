import type { ProfileSpec } from '../../../db/repositories/profiles.js';

/**
 * Commissioning-only fallback spec.
 *
 * IMPORTANT: none of these names come from the manufacturer's documentation. They are the
 * field names *IoT gateways in general* tend to use, listed so that the very
 * first unrecognised packet still shows something useful on screen instead of
 * being a blank row.
 *
 * Anything parsed through this spec is reported as UNKNOWN_SCHEMA and never
 * treated as a verified mapping. Replace it with a real `payload_profiles` row
 * (`veritek_schema_v1`) once a genuine packet has been captured.
 */
export const DISCOVERY_SPEC: ProfileSpec = {
  gatewayIdPaths: [
    'gateway_id', 'gatewayId', 'gateway', 'gw_id', 'gwId', 'gw',
    'device_id', 'deviceId', 'devId', 'dev_id', 'device',
    'client_id', 'clientId', 'serial', 'serial_number', 'sn',
    'imei', 'uid', 'id',
    'data.gateway_id', 'data.device_id', 'header.device_id', 'meta.device_id',
  ],
  meterIdPaths: [
    'meter_id', 'meterId', 'meter', 'meter_uid', 'meterUid', 'meter_name', 'meterName',
    'data.meter_id', 'data.meter',
  ],
  slaveIdPaths: [
    'slave_id', 'slaveId', 'slave', 'unit_id', 'unitId', 'unit',
    'address', 'addr', 'station', 'station_id', 'modbus_address', 'modbusAddress',
    'data.slave_id', 'data.unit_id',
  ],
  timestampPaths: [
    'timestamp', 'time', 'ts', 'datetime', 'date_time', 'dateTime',
    'sample_time', 'sampleTime', 'record_time', 'recordTime',
    'reading_time', 'readingTime', 'measured_at', 'measuredAt',
    'epoch', 'utc', 'created_at', 'createdAt',
    'data.timestamp', 'data.time', 'data.ts', 'header.timestamp',
  ],
  timestampFormat: 'auto',
  sequencePaths: ['seq', 'sequence', 'frame', 'frame_no', 'msg_id', 'msgId', 'index', 'no'],
  bufferedFlagPaths: ['buffered', 'is_buffered', 'isBuffered', 'cached', 'offline', 'replay', 'from_buffer'],
  batchPaths: [
    'records', 'readings', 'samples', 'data_list', 'dataList', 'items', 'list',
    'payload', 'buffer', 'history', 'entries', 'values_list', 'measurements_list',
  ],
  measurementPaths: [
    'registers', 'register', 'measurements', 'measurement', 'values', 'value_list',
    'data', 'params', 'parameters', 'tags', 'points', 'metrics', 'readings_data', 'd',
  ],
  registerArrayPaths: ['register_values', 'registerValues', 'regs', 'modbus', 'modbus_values'],
  registerBlockPaths: ['register_blocks', 'registerBlocks', 'blocks', 'raw_registers', 'rawRegisters'],
  registerAddressKey: 'address',
  registerValueKey: 'value',
  // During discovery we do want unknown numeric keys to surface, so that the
  // commissioning screen shows real values next to the real key names.
  passthroughUnmapped: true,
};

/**
 * Aliases from names meters and gateways commonly use to our metric keys.
 *
 * Used only as a *suggestion* engine for the commissioning screen ("this key
 * looks like voltage_l1") and by the simulator profile. It is never applied
 * silently to production telemetry: a real mapping goes in `keyMap` on a
 * payload profile, or in `source_key` on a register-map row.
 */
export const METRIC_ALIAS_HINTS: Record<string, string[]> = {
  voltage_l1: ['v1', 'vr', 'vrn', 'va', 'van', 'voltage_a', 'voltage_r', 'voltage_l1', 'u1', 'ul1'],
  voltage_l2: ['v2', 'vy', 'vyn', 'vb', 'vbn', 'voltage_b', 'voltage_y', 'voltage_l2', 'u2', 'ul2'],
  voltage_l3: ['v3', 'vb', 'vbn', 'vc', 'vcn', 'voltage_c', 'voltage_b', 'voltage_l3', 'u3', 'ul3'],
  voltage_l12: ['v12', 'vry', 'vab', 'voltage_ab', 'voltage_ry', 'ull1'],
  voltage_l23: ['v23', 'vyb', 'vbc', 'voltage_bc', 'voltage_yb'],
  voltage_l31: ['v31', 'vbr', 'vca', 'voltage_ca', 'voltage_br'],
  current_l1: ['i1', 'ir', 'ia', 'current_a', 'current_r', 'current_l1', 'amps_1'],
  current_l2: ['i2', 'iy', 'ib', 'current_b', 'current_y', 'current_l2', 'amps_2'],
  current_l3: ['i3', 'ib', 'ic', 'current_c', 'current_l3', 'amps_3'],
  active_power_kw: ['kw', 'p', 'power', 'active_power', 'total_kw', 'watts', 'pt'],
  reactive_power_kvar: ['kvar', 'q', 'reactive_power', 'total_kvar'],
  apparent_power_kva: ['kva', 's', 'apparent_power', 'total_kva'],
  power_factor: ['pf', 'power_factor', 'cos_phi', 'cosphi', 'pft'],
  frequency_hz: ['hz', 'freq', 'frequency', 'f'],
  energy_import_kwh: [
    'kwh', 'energy', 'import_kwh', 'active_energy', 'total_energy', 'energy_kwh',
    'kwh_import', 'imp_kwh', 'wh_import', 'energy_import',
  ],
  energy_export_kwh: ['export_kwh', 'kwh_export', 'exp_kwh', 'energy_export'],
  reactive_energy_kvarh: ['kvarh', 'reactive_energy', 'energy_kvarh'],
  apparent_energy_kvah: ['kvah', 'apparent_energy', 'energy_kvah'],
  demand_kw: ['demand', 'kw_demand', 'md', 'present_demand'],
  max_demand_kw: ['max_demand', 'maximum_demand', 'md_max', 'peak_demand'],
  thd_voltage_pct: ['thd_v', 'voltage_thd', 'thdv'],
  thd_current_pct: ['thd_i', 'current_thd', 'thdi'],
};

const aliasLookup = new Map<string, string>();
for (const [metric, aliases] of Object.entries(METRIC_ALIAS_HINTS)) {
  for (const alias of aliases) {
    const key = alias.toLowerCase().replace(/[^a-z0-9]/g, '');
    // First declaration wins, so ambiguous aliases (vb appears under both
    // voltage_l2 and voltage_l3) resolve deterministically rather than randomly.
    if (!aliasLookup.has(key)) aliasLookup.set(key, metric);
  }
  aliasLookup.set(metric.toLowerCase().replace(/[^a-z0-9]/g, ''), metric);
}

/**
 * Best guess at the platform metric a vendor key refers to.
 * Returns null when there is no confident match - silence beats a wrong guess.
 */
export function suggestMetric(key: string): string | null {
  return aliasLookup.get(key.toLowerCase().replace(/[^a-z0-9]/g, '')) ?? null;
}
