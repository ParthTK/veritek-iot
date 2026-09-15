/**
 * The boundary between "whatever the gateway sent" and "our schema".
 *
 * Everything downstream of this file - storage, rollups, energy maths, alerts,
 * the APIs - is written against these types only. A second gateway vendor is a
 * new adapter, not a change to the platform.
 */

export type ParseStatus = 'OK' | 'PARTIAL' | 'UNKNOWN_SCHEMA' | 'INVALID_PAYLOAD';

export type Quality = 'GOOD' | 'SUSPECT' | 'BAD' | 'ESTIMATED' | 'STALE';

/** A contiguous block of raw 16-bit Modbus registers awaiting decoding. */
export interface RawRegisterBlock {
  functionCode?: number | null;
  registerType?: string | null;
  startAddress: number;
  /** Register words as unsigned 16-bit integers. */
  words?: number[];
  /** ...or the same data as a hex string, which some gateways prefer. */
  hex?: string;
}

/**
 * One meter sample lifted out of a payload, still in the vendor's own terms.
 *
 * A single MQTT packet can contain several of these: one per Modbus slave, and
 * potentially many per slave when the gateway flushes its offline buffer.
 */
export interface ParsedPacket {
  gatewayUid: string | null;
  meterUid: string | null;
  slaveId: number | null;
  /** Measurement time in UTC, ISO-8601. Null when the payload carried none. */
  sourceTimestamp: string | null;
  timestampFormat: string | null;
  /** False when we had to assume an offset because the device sent none. */
  timestampHadOffset: boolean;
  assumedOffsetMinutes: number | null;
  /** Values the gateway already decoded, keyed by the vendor's own field name. */
  values: Record<string, number | string | boolean | null>;
  /** Raw register blocks that still need the Modbus decoder. */
  registerBlocks: RawRegisterBlock[];
  /** Individual address/value pairs, for gateways that send them sparsely. */
  registerValues: Array<{ address: number; value: number }>;
  /** Vendor sequence/frame counter, when present. */
  sequence: number | null;
  /** Vendor's own "this came from my buffer" marker, when one exists. */
  bufferedFlag: boolean | null;
  /** Anything else the payload carried, kept so nothing is silently dropped. */
  extra: Record<string, unknown>;
}

/** A JSON path seen in a payload, recorded to speed up commissioning. */
export interface ObservedPath {
  path: string;
  valueType: string;
  sample: string;
}

export interface AdapterResult {
  status: ParseStatus;
  /** Adapter that produced this result, e.g. 'technode'. */
  adapter: string;
  /** Payload profile (mapping config) that matched, if any. */
  profileId: string | null;
  profileName: string | null;
  packets: ParsedPacket[];
  warnings: string[];
  error?: string;
  /** Every JSON leaf path in the payload - drives the commissioning screen. */
  observedPaths: ObservedPath[];
}

/* ------------------------------------------------------ normalised output -- */

export interface NormalizedSample {
  metric: string;
  value: number;
  unit: string | null;
  quality: Quality;
  /** Register this value came from, when it was decoded from raw words. */
  registerAddress?: number | null;
  /** Vendor key this value arrived under, when it was already decoded. */
  sourceKey?: string | null;
}

/**
 * Our internal telemetry object. Deliberately *not* the vendor's shape.
 *
 * `measurements` uses the platform metric keys (voltage_l1, active_power_kw,
 * energy_import_kwh, ...) defined in metric_definitions - see section 4 and 11
 * of the spec.
 */
export interface NormalizedTelemetry {
  gatewayId: string;
  gatewayUid: string;
  meterId: string;
  meterUid: string;
  siteId: string | null;
  slaveId: number | null;
  /** Authoritative measurement time (UTC ISO). Source time when we have one. */
  timestamp: string;
  /** Exactly what the device claimed, or null if it claimed nothing. */
  sourceTimestamp: string | null;
  serverReceivedAt: string;
  source: string;
  isBuffered: boolean;
  /** Seconds between measurement and server receipt. */
  lagSeconds: number;
  measurements: Record<string, number>;
  samples: NormalizedSample[];
  fingerprint: string;
  /** Vendor keys we could not map to a metric - surfaced, never discarded. */
  unmappedKeys: string[];
}

export interface PayloadContext {
  transport: 'MQTT' | 'HTTP';
  topic: string | null;
  mqttClientId: string | null;
  /** Gateway uid asserted by the transport (HTTP token, MQTT client id). */
  assertedGatewayUid: string | null;
  receivedAt: string;
  /** Offset assumed for naive timestamps, minutes east of UTC. */
  defaultOffsetMinutes: number;
}

export interface PayloadAdapter {
  readonly name: string;
  /** Cheap check: could this adapter plausibly handle the payload? */
  canHandle(payload: unknown, context: PayloadContext): boolean;
  parse(payload: unknown, context: PayloadContext): AdapterResult;
}
