import express from 'express';
import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import { badRequest } from '../../core/errors.js';
import { createLogger } from '../../core/logger.js';
import { deviceAuth } from '../../api/middleware/auth.js';
import { rateLimit } from '../../api/middleware/rateLimit.js';
import { ingest } from '../telemetry/ingestion.js';

const log = createLogger('http:ingest');

/**
 * HTTP ingestion (spec section 2).
 *
 * The manufacturer lists HTTP alongside MQTT, so the path exists and is
 * exercised by the test suite - but MQTT is the preferred integration.
 *
 * Two properties matter here:
 *
 *   - the response is immediate. Decoding, meter resolution, energy maths and
 *     rollup invalidation all happen after the reply, so a gateway on a slow
 *     cellular link is never held open waiting for our database;
 *   - the body is read as raw bytes and stored verbatim before anything parses
 *     it, so the first packet from unknown hardware survives even if it is
 *     malformed.
 */

export function createIngestRouter(): express.Router {
  const router = express.Router();

  const limiter = rateLimit({
    perMinute: env.INGEST_RATE_LIMIT_PER_MINUTE,
    name: 'ingest',
    keyFor: (req) => req.gateway?.id ?? req.header('x-device-id') ?? req.ip ?? 'unknown',
  });

  // Raw body, not express.json: we must store exactly what was sent, including
  // whatever it is that makes it fail to parse.
  const rawBody = express.raw({
    type: () => true,
    limit: env.INGEST_MAX_PAYLOAD_BYTES,
  });

  const handler = async (req: Request, res: Response): Promise<void> => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));

    if (body.byteLength === 0) {
      throw badRequest('Request body was empty.');
    }

    const contentType = req.header('content-type') ?? null;
    if (contentType && !/json|text|octet-stream|x-www-form-urlencoded/i.test(contentType)) {
      log.warn('unexpected content type on the ingest endpoint', { contentType });
    }

    const receipt = await ingest({
      transport: 'HTTP',
      raw: body,
      topic: null,
      contentType,
      sourceIp: req.ip ?? null,
      // Identity from the device credential when there is one; the header is a
      // commissioning fallback and is treated as a hint, not proof.
      assertedGatewayUid: req.gateway?.gatewayUid ?? req.header('x-device-id') ?? null,
      gatewayId: req.gateway?.id ?? null,
    });

    // Deliberately terse and immediate - the contract in the spec.
    res.status(202).json({
      status: 'accepted',
      id: receipt.rawMessageId,
      receivedAt: receipt.receivedAt,
    });
  };

  /**
   * Vendor-specific path from the spec. It is an alias: the payload shape is
   * decided by the payload profile, not by the URL.
   */
  router.post('/veritek/ingest', deviceAuth, limiter, rawBody, handler);

  /** Generic path, so a second vendor needs no new route. */
  router.post('/:vendor/ingest', deviceAuth, limiter, rawBody, handler);

  /** Bare path for gateways that cannot be given a longer URL. */
  router.post('/ingest', deviceAuth, limiter, rawBody, handler);

  return router;
}
