import { env } from '../../config/env.js';
import { bus } from '../../core/events.js';
import { LogEvent } from '../../core/logEvents.js';
import { createLogger } from '../../core/logger.js';
import { payloadTooLarge } from '../../core/errors.js';
import type { Transport } from '../../db/repositories/rawMessages.js';
import { listPendingRawMessages, storeRawMessage } from '../../db/repositories/rawMessages.js';
import { processRawMessage } from './processor.js';

const log = createLogger('telemetry:ingestion');

/**
 * The single front door for inbound device data, whatever the transport.
 *
 * Two guarantees shape this file:
 *
 *   1. the bytes are on disk before anything tries to interpret them, so an
 *      unparseable first packet from new hardware is never lost (section 3);
 *   2. interpretation happens off the request path, so the HTTP endpoint can
 *      answer `{"status":"accepted"}` immediately and the MQTT consumer never
 *      blocks behind a slow database write (section 2).
 */

export interface IngestRequest {
  transport: Transport;
  raw: Buffer;
  topic?: string | null;
  mqttClientId?: string | null;
  sourceIp?: string | null;
  contentType?: string | null;
  /** Gateway asserted by the transport layer (device token, MQTT identity). */
  assertedGatewayUid?: string | null;
  gatewayId?: string | null;
}

export interface IngestReceipt {
  rawMessageId: string;
  receivedAt: string;
  bytes: number;
  queued: boolean;
}

/* ------------------------------------------------------------------ queue -- */

const queue: string[] = [];
let active = 0;
let draining = false;
let processedCount = 0;
let droppedCount = 0;

export function queueDepth(): number {
  return queue.length;
}

export function ingestStats(): { queued: number; active: number; processed: number; dropped: number } {
  return { queued: queue.length, active, processed: processedCount, dropped: droppedCount };
}

/**
 * Store a packet and schedule it for processing.
 *
 * @throws AppError(413) when the payload exceeds INGEST_MAX_PAYLOAD_BYTES
 */
export async function ingest(request: IngestRequest): Promise<IngestReceipt> {
  if (request.raw.byteLength > env.INGEST_MAX_PAYLOAD_BYTES) {
    log.warn('payload rejected as oversized', {
      event: LogEvent.PAYLOAD_TOO_LARGE,
      bytes: request.raw.byteLength,
      limit: env.INGEST_MAX_PAYLOAD_BYTES,
      topic: request.topic,
    });
    throw payloadTooLarge(
      'Payload of ' + request.raw.byteLength + ' bytes exceeds the ' +
        env.INGEST_MAX_PAYLOAD_BYTES + ' byte limit.',
    );
  }

  log.info('packet received', {
    event: LogEvent.GATEWAY_MESSAGE_RECEIVED,
    transport: request.transport,
    topic: request.topic,
    clientId: request.mqttClientId,
    gatewayUid: request.assertedGatewayUid,
    bytes: request.raw.byteLength,
  });

  const stored = await storeRawMessage({
    transport: request.transport,
    raw: request.raw,
    mqttTopic: request.topic ?? null,
    mqttClientId: request.mqttClientId ?? null,
    sourceIp: request.sourceIp ?? null,
    contentType: request.contentType ?? null,
    gatewayUid: request.assertedGatewayUid ?? null,
    gatewayId: request.gatewayId ?? null,
  });

  log.debug('raw packet stored', {
    event: LogEvent.RAW_MESSAGE_STORED,
    rawMessageId: stored.id,
    bytes: stored.byteSize,
    json: stored.json !== null,
    jsonError: stored.jsonError,
  });

  bus.emit('raw.stored', {
    id: stored.id,
    gatewayUid: request.assertedGatewayUid ?? null,
    transport: request.transport,
    topic: request.topic ?? null,
    receivedAt: stored.receivedAtServer,
  });

  const queued = enqueue(stored.id);
  return { rawMessageId: stored.id, receivedAt: stored.receivedAtServer, bytes: stored.byteSize, queued };
}

function enqueue(rawMessageId: string): boolean {
  if (queue.length >= env.INGEST_QUEUE_MAX) {
    // The row is already on disk, so nothing is lost - it simply waits for the
    // backlog drain on the next restart or manual replay.
    droppedCount += 1;
    log.error('ingest queue is full; packet deferred to the stored backlog', {
      queue: queue.length,
      limit: env.INGEST_QUEUE_MAX,
      rawMessageId,
    });
    return false;
  }
  queue.push(rawMessageId);
  void pump();
  return true;
}

async function pump(): Promise<void> {
  while (active < env.INGEST_WORKERS && queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    active += 1;
    void runOne(next).finally(() => {
      active -= 1;
      if (queue.length > 0) void pump();
    });
  }
}

async function runOne(rawMessageId: string): Promise<void> {
  try {
    await processRawMessage(rawMessageId);
    processedCount += 1;
  } catch (error) {
    // processRawMessage already records failures; this is the last-resort net
    // that keeps a bug in the pipeline from becoming an unhandled rejection.
    log.error('unhandled processing error', {
      event: LogEvent.PROCESSING_FAILED,
      rawMessageId,
      error,
    });
  }
}

/**
 * Re-queue packets that were stored but never processed - a crash mid-flight,
 * or a backlog that overflowed the in-memory queue.
 */
export async function drainPendingBacklog(): Promise<number> {
  if (draining) return 0;
  draining = true;
  let total = 0;
  try {
    for (;;) {
      const pending = await listPendingRawMessages(200);
      if (pending.length === 0) break;
      for (const message of pending) {
        await processRawMessage(message.id);
        total += 1;
      }
      if (pending.length < 200) break;
    }
    if (total > 0) log.info('replayed stored packets that had not been processed', { count: total });
  } finally {
    draining = false;
  }
  return total;
}

/** Wait for the queue to empty. Used by tests and the end-to-end verifier. */
export async function waitForIdle(timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (queue.length === 0 && active === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
