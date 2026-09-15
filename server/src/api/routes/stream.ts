import express from 'express';
import { attachSse } from '../../realtime/hub.js';
import { stringParam } from '../rangeQuery.js';

/**
 * Server-sent events for live dashboard updates.
 *
 *   GET /api/stream?siteId=...        every meter at a site
 *   GET /api/stream?meterId=...       one meter
 *   GET /api/stream?gatewayId=...     one gateway
 *
 * WebSocket clients get the same envelopes at `ws://<host>/ws` with the same
 * query parameters.
 */
export function createStreamRouter(): express.Router {
  const router = express.Router();

  router.get('/', (req, res) => {
    attachSse(res, {
      siteId: stringParam(req, 'siteId') ?? null,
      meterId: stringParam(req, 'meterId') ?? null,
      gatewayId: stringParam(req, 'gatewayId') ?? null,
    });
  });

  return router;
}
