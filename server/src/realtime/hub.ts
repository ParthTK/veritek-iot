import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Response } from 'express';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { bus } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import { nowIso } from '../core/time.js';

const log = createLogger('realtime');

/**
 * Live delivery to the dashboard (spec section 14).
 *
 * MQTT message -> normalise -> save -> internal event -> here -> browser.
 *
 * Both transports are offered because their failure modes differ: SSE rides on
 * plain HTTP and survives most corporate proxies, WebSocket is bidirectional
 * and lower overhead. Both carry identical event envelopes.
 */

export interface StreamFilter {
  siteId?: string | null;
  meterId?: string | null;
  gatewayId?: string | null;
}

interface Subscriber {
  id: number;
  filter: StreamFilter;
  send: (event: string, data: unknown) => void;
  close: () => void;
  kind: 'sse' | 'ws';
}

const subscribers = new Map<number, Subscriber>();
let nextId = 1;

export function subscriberCount(): { total: number; sse: number; ws: number } {
  let sse = 0;
  let ws = 0;
  for (const subscriber of subscribers.values()) {
    if (subscriber.kind === 'sse') sse += 1;
    else ws += 1;
  }
  return { total: subscribers.size, sse, ws };
}

function matches(filter: StreamFilter, subject: StreamFilter): boolean {
  if (filter.meterId && filter.meterId !== subject.meterId) return false;
  if (filter.gatewayId && filter.gatewayId !== subject.gatewayId) return false;
  if (filter.siteId && filter.siteId !== subject.siteId) return false;
  return true;
}

export function broadcast(event: string, subject: StreamFilter, data: unknown): void {
  for (const subscriber of subscribers.values()) {
    if (!matches(subscriber.filter, subject)) continue;
    try {
      subscriber.send(event, data);
    } catch (error) {
      log.debug('dropping a subscriber that could not be written to', { id: subscriber.id, error });
      subscribers.delete(subscriber.id);
    }
  }
}

/* ------------------------------------------------------------------- SSE -- */

export function attachSse(res: Response, filter: StreamFilter): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');

  const id = nextId++;
  const subscriber: Subscriber = {
    id,
    filter,
    kind: 'sse',
    send: (event, data) => {
      res.write('event: ' + event + '\n');
      res.write('data: ' + JSON.stringify(data) + '\n\n');
    },
    close: () => res.end(),
  };
  subscribers.set(id, subscriber);
  subscriber.send('hello', { at: nowIso(), filter, transport: 'sse' });

  // Proxies close idle connections; a comment frame every 25s keeps them open.
  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 25_000);
  keepAlive.unref?.();

  res.on('close', () => {
    clearInterval(keepAlive);
    subscribers.delete(id);
  });
}

/* ------------------------------------------------------------- WebSocket -- */

let wss: WebSocketServer | null = null;

export function attachWebSocketServer(server: HttpServer, path = '/ws'): void {
  if (wss) return;
  wss = new WebSocketServer({ server, path });

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url ?? path, 'http://localhost');
    const filter: StreamFilter = {
      siteId: url.searchParams.get('siteId'),
      meterId: url.searchParams.get('meterId'),
      gatewayId: url.searchParams.get('gatewayId'),
    };

    const id = nextId++;
    const subscriber: Subscriber = {
      id,
      filter,
      kind: 'ws',
      send: (event, data) => socket.send(JSON.stringify({ event, data })),
      close: () => socket.close(),
    };
    subscribers.set(id, subscriber);
    subscriber.send('hello', { at: nowIso(), filter, transport: 'ws' });

    socket.on('close', () => subscribers.delete(id));
    socket.on('error', () => subscribers.delete(id));
  });

  log.info('websocket endpoint ready', { path });
}

/* ---------------------------------------------------- pipeline wiring -- */

export function startRealtimeBridge(): void {
  bus.on('telemetry.saved', (payload) => {
    broadcast(
      'telemetry',
      { siteId: payload.siteId, meterId: payload.meterId, gatewayId: payload.gatewayId },
      {
        gatewayId: payload.gatewayId,
        gatewayUid: payload.gatewayUid,
        meterId: payload.meterId,
        siteId: payload.siteId,
        slaveId: payload.telemetry.slaveId,
        timestamp: payload.telemetry.timestamp,
        sourceTimestamp: payload.telemetry.sourceTimestamp,
        serverReceivedAt: payload.telemetry.serverReceivedAt,
        isBuffered: payload.buffered,
        measurements: payload.telemetry.measurements,
        quality: payload.samples.map((sample) => ({ metric: sample.metric, quality: sample.quality })),
      },
    );
  });

  bus.on('gateway.status', (payload) => {
    broadcast('gateway.status', { gatewayId: payload.gatewayId }, payload);
  });

  bus.on('alert.opened', (payload) => {
    broadcast('alert.opened', { meterId: payload.meterId, gatewayId: payload.gatewayId }, payload);
  });

  bus.on('alert.closed', (payload) => {
    broadcast('alert.closed', { meterId: payload.meterId, gatewayId: payload.gatewayId }, payload);
  });

  bus.on('raw.stored', (payload) => {
    // Commissioning screens watch this to show packets arriving live, before
    // anyone knows whether they parse.
    broadcast('raw.stored', {}, payload);
  });

  bus.on('raw.unknownSchema', (payload) => {
    broadcast('raw.unknownSchema', {}, payload);
  });

  bus.on('telemetry.duplicate', (payload) => {
    broadcast('telemetry.duplicate', { meterId: payload.meterId }, payload);
  });

  log.info('realtime bridge started');
}

export function closeRealtime(): void {
  for (const subscriber of subscribers.values()) {
    try {
      subscriber.close();
    } catch {
      /* already gone */
    }
  }
  subscribers.clear();
  wss?.close();
  wss = null;
}
