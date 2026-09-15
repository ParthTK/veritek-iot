import mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import { env, mqttProtocol } from '../../config/env.js';
import { LogEvent } from '../../core/logEvents.js';
import { createLogger } from '../../core/logger.js';
import { toSiteIso } from '../../core/time.js';
import { renderTemplate } from '../adapters/jsonPath.js';
import { SimulatedMeter } from './meterModel.js';

const log = createLogger('simulator');

/**
 * Gateway simulator (spec sections 20 and 21).
 *
 * IMPORTANT: the payload shape below is the SIMULATOR'S OWN FORMAT, invented
 * for this test harness. It is NOT Technode's payload - the manufacturer does
 * not publish one, and nothing in this repository claims otherwise. It exists
 * to prove the path end to end:
 *
 *   simulator -> MQTT -> consumer -> raw table -> normalisation -> telemetry
 *   -> rollups -> API -> dashboard
 *
 * It is decoded by the `simulator_v1` payload profile, exactly the same
 * mechanism the real gateway will use. Swapping the simulator for the hardware
 * therefore means adding a profile row, not changing code.
 */

export interface SimulatorOptions {
  gatewayUid?: string;
  slaveIds?: number[];
  intervalSeconds?: number;
  jitterSeconds?: number;
  topicTemplate?: string;
  brokerHost?: string;
  brokerPort?: number;
  username?: string;
  password?: string;
  timezone?: string;
  /** Publish over HTTP instead of MQTT, to exercise the other transport. */
  transport?: 'mqtt' | 'http';
  httpUrl?: string;
  deviceToken?: string;
}

export interface SimulatorPayload {
  gateway_id: string;
  slave_id: number;
  timestamp: string;
  /** Present only on replayed readings, mirroring an offline-buffer flush. */
  buffered?: boolean;
  seq: number;
  registers: Record<string, number>;
}

export class GatewaySimulator {
  private readonly gatewayUid: string;
  private readonly meters: SimulatedMeter[];
  private readonly intervalSeconds: number;
  private readonly jitterSeconds: number;
  private readonly topicTemplate: string;
  private readonly timezone: string;
  private readonly options: SimulatorOptions;

  private client: MqttClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private sequence = 0;
  private published = 0;
  /** Readings generated while "offline", awaiting a reconnect flush. */
  private buffer: SimulatorPayload[] = [];
  private offline = false;

  constructor(options: SimulatorOptions = {}) {
    this.options = options;
    this.gatewayUid = options.gatewayUid ?? env.SIMULATOR_GATEWAY_UID;
    this.intervalSeconds = options.intervalSeconds ?? env.SIMULATOR_INTERVAL_SECONDS;
    this.jitterSeconds = options.jitterSeconds ?? env.SIMULATOR_JITTER_SECONDS;
    this.topicTemplate = options.topicTemplate ?? env.SIMULATOR_TOPIC;
    this.timezone = options.timezone ?? env.DEFAULT_SITE_TIMEZONE;

    const slaveIds = options.slaveIds ?? env.SIMULATOR_SLAVE_IDS.map(Number).filter(Number.isFinite);
    this.meters = (slaveIds.length ? slaveIds : [1]).map(
      (slaveId) => new SimulatedMeter({ slaveId, timezone: this.timezone }),
    );
  }

  get topic(): string {
    return renderTemplate(this.topicTemplate, { gatewayUid: this.gatewayUid });
  }

  get stats(): { published: number; buffered: number; offline: boolean; gatewayUid: string } {
    return {
      published: this.published,
      buffered: this.buffer.length,
      offline: this.offline,
      gatewayUid: this.gatewayUid,
    };
  }

  async connect(): Promise<void> {
    if ((this.options.transport ?? env.SIMULATOR_TRANSPORT) === 'http') return;

    const host = this.options.brokerHost ?? env.MQTT_HOST;
    const port = this.options.brokerPort ?? env.MQTT_PORT;
    const url = mqttProtocol() + '://' + host + ':' + port;

    this.client = mqtt.connect(url, {
      clientId: 'sim-' + this.gatewayUid + '-' + Math.random().toString(36).slice(2, 8),
      username: this.options.username ?? env.EMBEDDED_BROKER_DEFAULT_USERNAME,
      password: this.options.password,
      clean: true,
      reconnectPeriod: 3000,
      connectTimeout: 15000,
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Simulator could not reach the broker at ' + url)), 15000);
      this.client?.once('connect', () => {
        clearTimeout(timeout);
        log.info('simulator connected to broker', { broker: host + ':' + port, gatewayUid: this.gatewayUid });
        resolve();
      });
      this.client?.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /** Build one reading per attached meter at instant `at`. */
  buildPayloads(at: Date, buffered = false): SimulatorPayload[] {
    return this.meters.map((meter) => {
      this.sequence += 1;
      const reading = meter.sample(at);
      const payload: SimulatorPayload = {
        gateway_id: this.gatewayUid,
        slave_id: meter.slaveId,
        // Site-local ISO with an explicit offset: the most likely shape for a
        // device with an RTC, and the one that exercises offset handling.
        timestamp: toSiteIso(at, this.timezone),
        seq: this.sequence,
        registers: reading as unknown as Record<string, number>,
      };
      if (buffered) payload.buffered = true;
      return payload;
    });
  }

  async publishPayload(payload: SimulatorPayload): Promise<boolean> {
    const transport = this.options.transport ?? env.SIMULATOR_TRANSPORT;

    if (transport === 'http') {
      const url = this.options.httpUrl ?? env.PUBLIC_BASE_URL + '/api/iot/technode/ingest';
      const token = this.options.deviceToken ?? env.SIMULATOR_DEVICE_TOKEN;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Id': this.gatewayUid,
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        log.error('HTTP ingest rejected the simulated packet', { status: response.status });
        return false;
      }
      this.published += 1;
      return true;
    }

    if (!this.client?.connected) {
      log.warn('simulator has no broker connection; reading kept in the buffer');
      return false;
    }

    return this.publishRaw(payload);
  }

  /**
   * Publish an arbitrary JSON body on the simulator's topic.
   *
   * Used by the test suite to send a deliberately unrecognisable payload and
   * confirm the consumer survives it (spec section 19), so it must not assume
   * the body has the simulator's own shape.
   */
  publishRaw(payload: unknown): Promise<boolean> {
    if (!this.client?.connected) {
      log.warn('simulator has no broker connection; nothing published');
      return Promise.resolve(false);
    }

    const reading = payload as Partial<SimulatorPayload>;
    return new Promise<boolean>((resolve) => {
      this.client?.publish(this.topic, JSON.stringify(payload), { qos: 1 }, (error) => {
        if (error) {
          log.error('simulator publish failed', { error });
          resolve(false);
          return;
        }
        this.published += 1;
        log.info('simulated reading published', {
          event: LogEvent.SIMULATOR_PUBLISHED,
          topic: this.topic,
          slaveId: reading.slave_id ?? null,
          timestamp: reading.timestamp ?? null,
          buffered: reading.buffered ?? false,
          kwh: reading.registers?.energy_import_kwh ?? null,
        });
        resolve(true);
      });
    });
  }

  private async tick(): Promise<void> {
    const at = new Date();
    const payloads = this.buildPayloads(at, this.offline);

    if (this.offline) {
      // Exactly what the gateway does through a cellular outage: keep polling,
      // keep the readings with their real measurement times, send them later.
      this.buffer.push(...payloads);
      log.info('simulated network outage: reading held in the device buffer', {
        buffered: this.buffer.length,
        at: payloads[0]?.timestamp,
      });
      return;
    }

    for (const payload of payloads) await this.publishPayload(payload);
  }

  /** Begin publishing on the configured interval, with jitter. */
  start(): void {
    if (this.timer) return;

    const schedule = (): void => {
      const jitterMs = (Math.random() - 0.5) * 2 * this.jitterSeconds * 1000;
      const delay = Math.max(1000, this.intervalSeconds * 1000 + jitterMs);
      this.timer = setTimeout(() => {
        void this.tick()
          .catch((error: unknown) => log.error('simulator tick failed', { error }))
          .finally(schedule);
      }, delay);
      this.timer.unref?.();
    };

    void this.tick().catch((error: unknown) => log.error('simulator tick failed', { error }));
    schedule();

    log.info('simulator started', {
      gatewayUid: this.gatewayUid,
      topic: this.topic,
      slaveIds: this.meters.map((meter) => meter.slaveId),
      intervalSeconds: this.intervalSeconds,
      transport: this.options.transport ?? env.SIMULATOR_TRANSPORT,
    });
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /* ------------------------------------------------- offline buffer test -- */

  /** Enter the "4G is down" state: keep measuring, stop transmitting. */
  goOffline(): void {
    this.offline = true;
    log.warn('simulator is now offline; readings will be buffered locally');
  }

  /**
   * Reconnect and flush the backlog.
   *
   * The readings go out together, minutes after they were measured, each still
   * carrying its original timestamp. That is the exact condition spec section
   * 21 asks us to prove: history must show 12:01, 12:02 and 12:03, not three
   * readings at 12:10.
   */
  async goOnline(): Promise<number> {
    this.offline = false;
    const backlog = [...this.buffer];
    this.buffer = [];

    log.warn('simulator is back online; flushing the buffer', { readings: backlog.length });
    for (const payload of backlog) await this.publishPayload(payload);
    return backlog.length;
  }

  /**
   * Generate a run of historical readings and publish them in one burst.
   *
   * Shortcut for the automated buffering test, which does not want to wait out
   * a real five-minute outage.
   *
   * Use it on a simulator whose meters have not already published readings
   * newer than `minutesBack`. The cumulative energy register climbs as the
   * series is generated, so mixing a back-fill into a meter that has already
   * reported "now" would produce a counter that moves backwards in measurement
   * order - physically impossible, and correctly rejected downstream as a
   * BACKWARD counter event.
   */
  async replayHistorical(options: {
    minutesBack: number;
    stepSeconds: number;
    /** Send everything twice, to prove duplicates are rejected. */
    duplicate?: boolean;
  }): Promise<SimulatorPayload[]> {
    const now = Date.now();
    const startMs = now - options.minutesBack * 60_000;
    for (const meter of this.meters) meter.primeAt(new Date(startMs - options.stepSeconds * 1000));

    const payloads: SimulatorPayload[] = [];
    for (let at = startMs; at <= now; at += options.stepSeconds * 1000) {
      payloads.push(...this.buildPayloads(new Date(at), true));
    }

    for (const payload of payloads) await this.publishPayload(payload);
    if (options.duplicate) {
      log.info('republishing the same backlog to exercise duplicate rejection', { readings: payloads.length });
      for (const payload of payloads) await this.publishPayload(payload);
    }
    return payloads;
  }

  async disconnect(): Promise<void> {
    this.stop();
    if (!this.client) return;
    await new Promise<void>((resolve) => this.client?.end(false, {}, () => resolve()));
    this.client = null;
  }
}
