import { newId } from '../../core/hash.js';
import { nowIso } from '../../core/time.js';
import { db } from '../index.js';
import { toBool, toInt, toIso, toJson, toNum, toStr } from '../types.js';

/* ----------------------------------------------------------- meter models -- */

export interface MeterModel {
  id: string;
  manufacturer: string;
  model: string;
  protocol: string;
  defaultBaudRate: number | null;
  defaultParity: string | null;
  defaultStopBits: number | null;
  defaultDataBits: number | null;
  defaultSlaveId: number | null;
  defaultPollIntervalSeconds: number | null;
  /** False until the register table has been checked against the meter manual. */
  verified: boolean;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

function mapModel(row: Record<string, unknown>): MeterModel {
  return {
    id: String(row.id),
    manufacturer: String(row.manufacturer),
    model: String(row.model),
    protocol: toStr(row.protocol) ?? 'MODBUS_RTU',
    defaultBaudRate: toInt(row.default_baud_rate),
    defaultParity: toStr(row.default_parity),
    defaultStopBits: toInt(row.default_stop_bits),
    defaultDataBits: toInt(row.default_data_bits),
    defaultSlaveId: toInt(row.default_slave_id),
    defaultPollIntervalSeconds: toInt(row.default_poll_interval_seconds),
    verified: toBool(row.verified),
    notes: toStr(row.notes),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export async function listMeterModels(): Promise<MeterModel[]> {
  return (await db().rows('SELECT * FROM meter_models ORDER BY manufacturer, model')).map(mapModel);
}

export async function getMeterModel(id: string): Promise<MeterModel | null> {
  const row = await db().one('SELECT * FROM meter_models WHERE id = $1', [id]);
  return row ? mapModel(row) : null;
}

export interface MeterModelInput {
  id?: string;
  manufacturer: string;
  model: string;
  protocol?: string;
  defaultBaudRate?: number | null;
  defaultParity?: string | null;
  defaultStopBits?: number | null;
  defaultDataBits?: number | null;
  defaultSlaveId?: number | null;
  defaultPollIntervalSeconds?: number | null;
  verified?: boolean;
  notes?: string | null;
}

export async function upsertMeterModel(input: MeterModelInput): Promise<MeterModel> {
  const existing = await db().one<{ id: string }>(
    'SELECT id FROM meter_models WHERE manufacturer = $1 AND model = $2',
    [input.manufacturer, input.model],
  );
  const id = existing?.id ?? input.id ?? newId('mm');
  const now = nowIso();
  await db().execute(
    'INSERT INTO meter_models (id, manufacturer, model, protocol, default_baud_rate, default_parity, ' +
      'default_stop_bits, default_data_bits, default_slave_id, default_poll_interval_seconds, verified, ' +
      'notes, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) ' +
      'ON CONFLICT (id) DO UPDATE SET manufacturer = excluded.manufacturer, model = excluded.model, ' +
      'protocol = excluded.protocol, default_baud_rate = excluded.default_baud_rate, ' +
      'default_parity = excluded.default_parity, default_stop_bits = excluded.default_stop_bits, ' +
      'default_data_bits = excluded.default_data_bits, default_slave_id = excluded.default_slave_id, ' +
      'default_poll_interval_seconds = excluded.default_poll_interval_seconds, ' +
      'verified = excluded.verified, notes = excluded.notes, updated_at = excluded.updated_at',
    [
      id, input.manufacturer, input.model, input.protocol ?? 'MODBUS_RTU',
      input.defaultBaudRate ?? null, input.defaultParity ?? null, input.defaultStopBits ?? null,
      input.defaultDataBits ?? null, input.defaultSlaveId ?? null,
      input.defaultPollIntervalSeconds ?? null, input.verified ?? false, input.notes ?? null, now,
    ],
  );
  const model = await getMeterModel(id);
  if (!model) throw new Error('Failed to persist meter model');
  return model;
}

export async function deleteMeterModel(id: string): Promise<boolean> {
  return (await db().execute('DELETE FROM meter_models WHERE id = $1', [id])) > 0;
}

/* --------------------------------------------------------- register maps -- */

export type ModbusDatatype =
  | 'INT16' | 'UINT16' | 'INT32' | 'UINT32' | 'INT64' | 'UINT64'
  | 'FLOAT32' | 'FLOAT64' | 'BOOL' | 'BITFIELD' | 'STRING';

export interface RegisterMapEntry {
  id: string;
  meterModelId: string;
  metricKey: string;
  displayName: string | null;
  slaveId: number | null;
  functionCode: number;
  registerType: string;
  registerAddress: number;
  registerLength: number;
  datatype: ModbusDatatype;
  byteOrder: 'big' | 'little';
  wordOrder: 'big' | 'little';
  bitMask: number | null;
  bitOffset: number | null;
  scale: number;
  valueOffset: number;
  unit: string | null;
  writable: boolean;
  enabled: boolean;
  /** Vendor JSON key this metric arrives under when the gateway pre-decodes. */
  sourceKey: string | null;
  pollIntervalSeconds: number | null;
  notes: string | null;
}

function mapRegister(row: Record<string, unknown>): RegisterMapEntry {
  return {
    id: String(row.id),
    meterModelId: String(row.meter_model_id),
    metricKey: String(row.metric_key),
    displayName: toStr(row.display_name),
    slaveId: toInt(row.slave_id),
    functionCode: toInt(row.function_code) ?? 3,
    registerType: toStr(row.register_type) ?? 'HOLDING',
    registerAddress: toInt(row.register_address) ?? 0,
    registerLength: toInt(row.register_length) ?? 2,
    datatype: (toStr(row.datatype) as ModbusDatatype) ?? 'FLOAT32',
    byteOrder: (toStr(row.byte_order) as 'big' | 'little') ?? 'big',
    wordOrder: (toStr(row.word_order) as 'big' | 'little') ?? 'big',
    bitMask: toInt(row.bit_mask),
    bitOffset: toInt(row.bit_offset),
    scale: toNum(row.scale) ?? 1,
    valueOffset: toNum(row.value_offset) ?? 0,
    unit: toStr(row.unit),
    writable: toBool(row.writable),
    enabled: toBool(row.enabled),
    sourceKey: toStr(row.source_key),
    pollIntervalSeconds: toInt(row.poll_interval_seconds),
    notes: toStr(row.notes),
  };
}

export async function listRegisterMap(meterModelId: string): Promise<RegisterMapEntry[]> {
  const rows = await db().rows(
    'SELECT * FROM modbus_register_maps WHERE meter_model_id = $1 ORDER BY register_address, metric_key',
    [meterModelId],
  );
  return rows.map(mapRegister);
}

export interface RegisterMapInput {
  id?: string;
  meterModelId: string;
  metricKey: string;
  displayName?: string | null;
  slaveId?: number | null;
  functionCode?: number;
  registerType?: string;
  registerAddress: number;
  registerLength?: number;
  datatype: ModbusDatatype;
  byteOrder?: 'big' | 'little';
  wordOrder?: 'big' | 'little';
  bitMask?: number | null;
  bitOffset?: number | null;
  scale?: number;
  valueOffset?: number;
  unit?: string | null;
  writable?: boolean;
  enabled?: boolean;
  sourceKey?: string | null;
  pollIntervalSeconds?: number | null;
  notes?: string | null;
}

export async function upsertRegisterMapEntry(input: RegisterMapInput): Promise<RegisterMapEntry> {
  const existing = await db().one<{ id: string }>(
    'SELECT id FROM modbus_register_maps WHERE meter_model_id = $1 AND metric_key = $2',
    [input.meterModelId, input.metricKey],
  );
  const id = existing?.id ?? input.id ?? newId('reg');
  const now = nowIso();
  await db().execute(
    'INSERT INTO modbus_register_maps (id, meter_model_id, metric_key, display_name, slave_id, function_code, ' +
      'register_type, register_address, register_length, datatype, byte_order, word_order, bit_mask, bit_offset, ' +
      'scale, value_offset, unit, writable, enabled, source_key, poll_interval_seconds, notes, created_at, updated_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$23) ' +
      'ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name, slave_id = excluded.slave_id, ' +
      'function_code = excluded.function_code, register_type = excluded.register_type, ' +
      'register_address = excluded.register_address, register_length = excluded.register_length, ' +
      'datatype = excluded.datatype, byte_order = excluded.byte_order, word_order = excluded.word_order, ' +
      'bit_mask = excluded.bit_mask, bit_offset = excluded.bit_offset, scale = excluded.scale, ' +
      'value_offset = excluded.value_offset, unit = excluded.unit, writable = excluded.writable, ' +
      'enabled = excluded.enabled, source_key = excluded.source_key, ' +
      'poll_interval_seconds = excluded.poll_interval_seconds, notes = excluded.notes, updated_at = excluded.updated_at',
    [
      id, input.meterModelId, input.metricKey, input.displayName ?? null, input.slaveId ?? null,
      input.functionCode ?? 3, input.registerType ?? 'HOLDING', input.registerAddress,
      input.registerLength ?? 2, input.datatype, input.byteOrder ?? 'big', input.wordOrder ?? 'big',
      input.bitMask ?? null, input.bitOffset ?? null, input.scale ?? 1, input.valueOffset ?? 0,
      input.unit ?? null, input.writable ?? false, input.enabled ?? true, input.sourceKey ?? null,
      input.pollIntervalSeconds ?? null, input.notes ?? null, now,
    ],
  );
  const row = await db().one('SELECT * FROM modbus_register_maps WHERE id = $1', [id]);
  if (!row) throw new Error('Failed to persist register map entry');
  return mapRegister(row);
}

export async function deleteRegisterMapEntry(id: string): Promise<boolean> {
  return (await db().execute('DELETE FROM modbus_register_maps WHERE id = $1', [id])) > 0;
}

/* ---------------------------------------------------------------- meters -- */

export interface Meter {
  id: string;
  meterUid: string;
  siteId: string | null;
  gatewayId: string | null;
  meterModelId: string | null;
  meterName: string;
  location: string | null;
  slaveId: number | null;
  baudRate: number | null;
  parity: string | null;
  stopBits: number | null;
  dataBits: number | null;
  pollIntervalSeconds: number | null;
  enabled: boolean;
  status: string;
  lastDataAt: string | null;
  installedAt: string | null;
  config: Record<string, unknown>;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

function mapMeter(row: Record<string, unknown>): Meter {
  return {
    id: String(row.id),
    meterUid: String(row.meter_uid),
    siteId: toStr(row.site_id),
    gatewayId: toStr(row.gateway_id),
    meterModelId: toStr(row.meter_model_id),
    meterName: String(row.meter_name),
    location: toStr(row.location),
    slaveId: toInt(row.slave_id),
    baudRate: toInt(row.baud_rate),
    parity: toStr(row.parity),
    stopBits: toInt(row.stop_bits),
    dataBits: toInt(row.data_bits),
    pollIntervalSeconds: toInt(row.poll_interval_seconds),
    enabled: toBool(row.enabled),
    status: toStr(row.status) ?? 'UNKNOWN',
    lastDataAt: toIso(row.last_data_at),
    installedAt: toIso(row.installed_at),
    config: toJson<Record<string, unknown>>(row.config, {}),
    notes: toStr(row.notes),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export async function listMeters(filter: { gatewayId?: string; siteId?: string } = {}): Promise<Meter[]> {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.gatewayId) {
    params.push(filter.gatewayId);
    clauses.push('gateway_id = $' + params.length);
  }
  if (filter.siteId) {
    params.push(filter.siteId);
    clauses.push('site_id = $' + params.length);
  }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  return (await db().rows('SELECT * FROM meters' + where + ' ORDER BY meter_name', params)).map(mapMeter);
}

export async function getMeter(id: string): Promise<Meter | null> {
  const row = await db().one('SELECT * FROM meters WHERE id = $1', [id]);
  return row ? mapMeter(row) : null;
}

export async function getMeterByUid(meterUid: string): Promise<Meter | null> {
  const row = await db().one('SELECT * FROM meters WHERE meter_uid = $1', [meterUid]);
  return row ? mapMeter(row) : null;
}

/** The meter hanging off `gatewayId` at Modbus slave address `slaveId`. */
export async function getMeterByGatewaySlave(gatewayId: string, slaveId: number): Promise<Meter | null> {
  const row = await db().one('SELECT * FROM meters WHERE gateway_id = $1 AND slave_id = $2', [gatewayId, slaveId]);
  return row ? mapMeter(row) : null;
}

/** Used when a gateway sends a single unidentified meter (no slave id at all). */
export async function getSoleMeterForGateway(gatewayId: string): Promise<Meter | null> {
  const rows = await db().rows('SELECT * FROM meters WHERE gateway_id = $1 LIMIT 2', [gatewayId]);
  return rows.length === 1 && rows[0] ? mapMeter(rows[0]) : null;
}

export interface MeterInput {
  id?: string;
  meterUid: string;
  siteId?: string | null;
  gatewayId?: string | null;
  meterModelId?: string | null;
  meterName?: string;
  location?: string | null;
  slaveId?: number | null;
  baudRate?: number | null;
  parity?: string | null;
  stopBits?: number | null;
  dataBits?: number | null;
  pollIntervalSeconds?: number | null;
  enabled?: boolean;
  installedAt?: string | null;
  config?: Record<string, unknown>;
  notes?: string | null;
}

export async function upsertMeter(input: MeterInput): Promise<Meter> {
  const existing = await getMeterByUid(input.meterUid);
  const id = existing?.id ?? input.id ?? newId('mtr');
  const now = nowIso();

  if (existing) {
    const merged = { ...existing, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as Meter;
    await db().execute(
      'UPDATE meters SET site_id = $2, gateway_id = $3, meter_model_id = $4, meter_name = $5, location = $6, ' +
        'slave_id = $7, baud_rate = $8, parity = $9, stop_bits = $10, data_bits = $11, ' +
        'poll_interval_seconds = $12, enabled = $13, installed_at = $14, config = $15, notes = $16, ' +
        'updated_at = $17 WHERE id = $1',
      [
        id, merged.siteId, merged.gatewayId, merged.meterModelId, merged.meterName, merged.location,
        merged.slaveId, merged.baudRate, merged.parity, merged.stopBits, merged.dataBits,
        merged.pollIntervalSeconds, merged.enabled, merged.installedAt, merged.config ?? {}, merged.notes, now,
      ],
    );
  } else {
    await db().execute(
      'INSERT INTO meters (id, meter_uid, site_id, gateway_id, meter_model_id, meter_name, location, slave_id, ' +
        'baud_rate, parity, stop_bits, data_bits, poll_interval_seconds, enabled, status, installed_at, config, ' +
        'notes, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)',
      [
        id, input.meterUid, input.siteId ?? null, input.gatewayId ?? null, input.meterModelId ?? null,
        input.meterName ?? input.meterUid, input.location ?? null, input.slaveId ?? null,
        input.baudRate ?? null, input.parity ?? null, input.stopBits ?? null, input.dataBits ?? null,
        input.pollIntervalSeconds ?? null, input.enabled ?? true, 'UNKNOWN', input.installedAt ?? null,
        input.config ?? {}, input.notes ?? null, now,
      ],
    );
  }

  const meter = await getMeter(id);
  if (!meter) throw new Error('Failed to persist meter ' + input.meterUid);
  return meter;
}

export async function deleteMeter(id: string): Promise<boolean> {
  return (await db().execute('DELETE FROM meters WHERE id = $1', [id])) > 0;
}

export async function touchMeterData(id: string, at: string): Promise<void> {
  await db().execute(
    'UPDATE meters SET last_data_at = CASE WHEN last_data_at IS NULL OR last_data_at < $2 THEN $2 ELSE last_data_at END, ' +
      "status = 'ONLINE', updated_at = $2 WHERE id = $1",
    [id, at],
  );
}

export async function setMeterStatus(id: string, status: string): Promise<void> {
  await db().execute('UPDATE meters SET status = $2, updated_at = $3 WHERE id = $1', [id, status, nowIso()]);
}
