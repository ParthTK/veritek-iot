import { EventEmitter } from 'node:events';
import type { NormalizedSample, NormalizedTelemetry } from '../iot/adapters/types.js';

/**
 * In-process event bus.
 *
 * The ingest pipeline publishes here; the realtime hub, the alert engine and the
 * aggregation scheduler subscribe. Keeping the pipeline free of direct
 * references to its consumers is what lets a second gateway vendor, an extra
 * alert channel or an external message broker be dropped in later without
 * touching ingestion code.
 */
export interface AppEvents {
  'telemetry.saved': {
    gatewayUid: string;
    gatewayId: string;
    meterId: string;
    siteId: string | null;
    telemetry: NormalizedTelemetry;
    samples: NormalizedSample[];
    /** True when the packet arrived materially later than it was measured. */
    buffered: boolean;
  };
  'telemetry.duplicate': { gatewayUid: string; meterId: string | null; fingerprint: string };
  'raw.stored': {
    id: string;
    gatewayUid: string | null;
    transport: 'MQTT' | 'HTTP';
    topic: string | null;
    receivedAt: string;
  };
  'raw.unknownSchema': {
    id: string;
    gatewayUid: string | null;
    topic: string | null;
    reason: string;
  };
  'gateway.status': {
    gatewayId: string;
    gatewayUid: string;
    status: 'ONLINE' | 'OFFLINE' | 'DEGRADED' | 'UNKNOWN';
    previous: string;
    lastSeenAt: string | null;
    lastDataAt: string | null;
  };
  'alert.opened': { id: string; ruleId: string; meterId: string | null; gatewayId: string | null; severity: string; message: string; value: number | null };
  'alert.closed': { id: string; ruleId: string; meterId: string | null; gatewayId: string | null };
  'command.updated': { id: string; gatewayId: string; status: string };
}

export type AppEventName = keyof AppEvents;

class TypedBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit<K extends AppEventName>(name: K, payload: AppEvents[K]): void {
    this.emitter.emit(name, payload);
  }

  on<K extends AppEventName>(name: K, handler: (payload: AppEvents[K]) => void): () => void {
    this.emitter.on(name, handler as (...args: unknown[]) => void);
    return () => this.emitter.off(name, handler as (...args: unknown[]) => void);
  }

  off<K extends AppEventName>(name: K, handler: (payload: AppEvents[K]) => void): void {
    this.emitter.off(name, handler as (...args: unknown[]) => void);
  }
}

export const bus = new TypedBus();
