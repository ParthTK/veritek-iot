import express from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { unauthorized } from '../../core/errors.js';
import { LogEvent } from '../../core/logEvents.js';
import { createLogger } from '../../core/logger.js';
import { audit, authenticate } from '../../db/repositories/users.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const log = createLogger('api:auth');

const loginSchema = z.object({
  email: z.string().min(3),
  password: z.string().min(1),
});

export function createAuthRouter(): express.Router {
  const router = express.Router();

  // Tight limit: this is the endpoint worth brute-forcing.
  const loginLimiter = rateLimit({ perMinute: 20, name: 'login', keyFor: (req) => req.ip ?? 'unknown' });

  router.post('/login', loginLimiter, async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = await authenticate(email, password);

    if (!user) {
      // One message for every failure mode, so the response cannot be used to
      // enumerate which addresses have accounts.
      log.warn('failed sign-in', { event: LogEvent.AUTH_FAILED, email, ip: req.ip });
      throw unauthorized('Incorrect email or password.');
    }

    await audit({ actor: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, ip: req.ip ?? null });
    res.json({
      token: signToken(user),
      expiresInSeconds: env.JWT_TTL_SECONDS,
      user,
    });
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user ?? null, authEnabled: env.AUTH_ENABLED });
  });

  return router;
}
