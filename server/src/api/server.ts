import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { createLogger } from '../core/logger.js';
import { createIngestRouter } from '../iot/http/ingest.js';
import { attachWebSocketServer } from '../realtime/hub.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requireAuth } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import { createAdminRouter } from './routes/admin.js';
import { createBrokerAuthRouter } from './routes/brokerAuth.js';
import { createProvisioningRouter } from './routes/provisioning.js';
import { createAlertsRouter } from './routes/alerts.js';
import { createAuthRouter } from './routes/auth.js';
import { createCommissioningRouter } from './routes/commissioning.js';
import { createGatewaysRouter } from './routes/gateways.js';
import { createHealthRouter } from './routes/health.js';
import { createMetersRouter } from './routes/meters.js';
import { createSitesRouter } from './routes/sites.js';
import { createStreamRouter } from './routes/stream.js';
import { metricsContentType, metricsText, refreshStateMetrics } from '../observability/metrics.js';

const log = createLogger('api');
const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, '..', '..', 'public');

function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header('origin');
  // Explicit allow-list; the dashboard sends a bearer token, so a wildcard with
  // credentials is neither allowed by browsers nor desirable.
  if (origin && env.CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,Authorization,X-Device-Token,X-Device-Secret,X-Device-Id',
  );
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.removeHeader('X-Powered-By');
  next();
}

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  // Needed for correct req.ip behind a reverse proxy, which the rate limiter keys on.
  app.set('trust proxy', true);

  app.use(securityHeaders);
  app.use(cors);

  /* Device ingestion. Mounted before the JSON body parser because it must read
     the raw bytes, and outside requireAuth because it has its own device auth. */
  app.use('/api/iot', createIngestRouter());

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));

  if (env.BROKER_WEBHOOK_ENABLED) {
    // The broker authenticates with a shared secret, not a dashboard session,
    // so this mounts outside requireAuth. Deployment binds it to the internal
    // network only - see deploy/ and the firewall notes.
    app.use('/internal/broker', createBrokerAuthRouter());
  }

  if (env.METRICS_ENABLED) {
    app.get(env.METRICS_PATH, async (req, res) => {
      if (env.METRICS_TOKEN) {
        const header = req.header('authorization');
        if (header !== 'Bearer ' + env.METRICS_TOKEN) {
          res.status(401).type('text/plain').send('unauthorized');
          return;
        }
      }
      await refreshStateMetrics().catch(() => undefined);
      res.setHeader('Content-Type', metricsContentType());
      res.send(await metricsText());
    });
  }

  app.use('/api/health', createHealthRouter());
  app.use('/api/auth', createAuthRouter());

  const dashboardLimiter = rateLimit({
    perMinute: env.API_RATE_LIMIT_PER_MINUTE,
    name: 'dashboard',
    keyFor: (req) => req.user?.id ?? req.ip ?? 'unknown',
  });

  app.use('/api/stream', requireAuth, createStreamRouter());
  app.use('/api/sites', requireAuth, dashboardLimiter, createSitesRouter());
  app.use('/api/meters', requireAuth, dashboardLimiter, createMetersRouter());
  app.use('/api/gateways', requireAuth, dashboardLimiter, createGatewaysRouter());
  app.use('/api/alerts', requireAuth, dashboardLimiter, createAlertsRouter());
  app.use('/api/commissioning', requireAuth, dashboardLimiter, createCommissioningRouter());
  app.use('/api/admin', requireAuth, dashboardLimiter, createAdminRouter());
  app.use('/api/provisioning', requireAuth, dashboardLimiter, createProvisioningRouter());

  /* The internal commissioning screen (spec section 24). Static, no build step,
     talks to the same APIs the dashboard will. */
  app.get('/commissioning', (_req, res) => {
    res.sendFile(join(PUBLIC_DIR, 'commissioning.html'));
  });
  app.use('/commissioning', express.static(PUBLIC_DIR, { index: 'commissioning.html' }));
  app.get('/', (_req, res) => {
    res.json({
      service: 'veritek-iot-backend',
      commissioning: '/commissioning',
      health: '/api/health',
      ingest: '/api/iot/technode/ingest',
      stream: '/api/stream',
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export function startHttpServer(app: Express): Promise<Server> {
  const server = createServer(app);
  attachWebSocketServer(server, '/ws');

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.PORT, env.HOST, () => {
      log.info('http server listening', {
        host: env.HOST,
        port: env.PORT,
        commissioning: env.PUBLIC_BASE_URL + '/commissioning',
      });
      resolve(server);
    });
  });
}
