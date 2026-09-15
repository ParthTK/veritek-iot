import type { NextFunction, Request, Response } from 'express';
import { tooManyRequests } from '../../core/errors.js';
import { LogEvent } from '../../core/logEvents.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('api:rateLimit');

/**
 * Token-bucket rate limiting (spec section 18).
 *
 * In-process on purpose: it protects a single instance from a device stuck in a
 * publish loop, which is the realistic failure here. A multi-instance
 * deployment should also rate-limit at the ingress/broker.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitOptions {
  /** Sustained rate. Burst capacity equals this value. */
  perMinute: number;
  /** Bucket key. Defaults to the device identity, else the client IP. */
  keyFor?: (req: Request) => string;
  name?: string;
}

export function rateLimit(options: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  const capacity = options.perMinute;
  const refillPerMs = capacity / 60_000;
  const name = options.name ?? 'default';

  // Buckets for callers that have gone away should not accumulate forever.
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [key, bucket] of buckets) {
      if (bucket.updatedAt < cutoff) buckets.delete(key);
    }
  }, 5 * 60_000);
  sweeper.unref?.();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = options.keyFor?.(req) ?? req.gateway?.id ?? req.ip ?? 'unknown';
    const now = Date.now();
    const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: now };

    bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
    bucket.updatedAt = now;

    if (bucket.tokens < 1) {
      buckets.set(key, bucket);
      const retryAfter = Math.ceil((1 - bucket.tokens) / refillPerMs / 1000);
      res.setHeader('Retry-After', String(Math.max(retryAfter, 1)));
      log.warn('rate limit exceeded', { event: LogEvent.RATE_LIMITED, limiter: name, key, capacity });
      next(tooManyRequests('Rate limit of ' + capacity + ' requests/minute exceeded.'));
      return;
    }

    bucket.tokens -= 1;
    buckets.set(key, bucket);
    res.setHeader('X-RateLimit-Limit', String(capacity));
    res.setHeader('X-RateLimit-Remaining', String(Math.floor(bucket.tokens)));
    next();
  };
}
