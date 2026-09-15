import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../../config/env.js';
import { forbidden, unauthorized } from '../../core/errors.js';
import { LogEvent } from '../../core/logEvents.js';
import { createLogger } from '../../core/logger.js';
import type { Gateway } from '../../db/repositories/gateways.js';
import { findGatewayByToken } from '../../db/repositories/gateways.js';
import type { User, UserRole } from '../../db/repositories/users.js';
import { getUser } from '../../db/repositories/users.js';

const log = createLogger('api:auth');

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
    gateway?: Gateway;
  }
}

/* --------------------------------------------------------------- JWT (HS256) -- */

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export interface TokenClaims {
  sub: string;
  role: UserRole;
  email: string;
  iat: number;
  exp: number;
}

export function signToken(user: User, ttlSeconds = env.JWT_TTL_SECONDS): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims: TokenClaims = {
    sub: user.id,
    role: user.role,
    email: user.email,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
  };
  const body = base64url(JSON.stringify(claims));
  const signature = createHmac('sha256', env.JWT_SECRET).update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + signature;
}

export function verifyToken(token: string): TokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  if (!header || !body || !signature) return null;

  const expected = createHmac('sha256', env.JWT_SECRET).update(header + '.' + body).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenClaims;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

function bearerFrom(req: Request): string | null {
  const header = req.header('authorization');
  if (header && /^bearer /i.test(header)) return header.slice(7).trim();
  const query = req.query.access_token;
  // Query tokens exist only for EventSource, which cannot set headers.
  if (typeof query === 'string' && query) return query;
  return null;
}

/* ------------------------------------------------------------- user auth -- */

/**
 * Dashboard authentication.
 *
 * AUTH_ENABLED=false is a bench convenience only; the production warnings in
 * `env.ts` call it out, and it must never be shipped that way.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!env.AUTH_ENABLED) {
    next();
    return;
  }

  const token = bearerFrom(req);
  if (!token) {
    next(unauthorized('A bearer token is required.'));
    return;
  }

  const claims = verifyToken(token);
  if (!claims) {
    log.warn('rejected an invalid or expired token', {
      event: LogEvent.AUTH_FAILED,
      path: req.path,
      ip: req.ip,
    });
    next(unauthorized('Token is invalid or has expired.'));
    return;
  }

  void getUser(claims.sub)
    .then((user) => {
      if (!user || !user.active) {
        next(unauthorized('Account is no longer active.'));
        return;
      }
      req.user = user;
      next();
    })
    .catch(next);
}

const ROLE_RANK: Record<UserRole, number> = {
  Viewer: 1,
  Operator: 2,
  Admin: 3,
  'Super Admin': 4,
};

export function requireRole(minimum: UserRole) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!env.AUTH_ENABLED) {
      next();
      return;
    }
    const role = req.user?.role;
    if (!role || ROLE_RANK[role] < ROLE_RANK[minimum]) {
      next(forbidden('This action requires the ' + minimum + ' role or higher.'));
      return;
    }
    next();
  };
}

/* ----------------------------------------------------------- device auth -- */

/**
 * Authenticate a gateway on the HTTP ingest endpoint.
 *
 * Credentials come from `Authorization: Bearer <token>` or `X-Device-Token`.
 * With INGEST_REQUIRE_AUTH=false an unauthenticated packet is still accepted -
 * necessary during commissioning, when the gateway's credential support is one
 * of the open questions - but the identity it claims is then untrusted.
 */
export function deviceAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = bearerFrom(req) ?? req.header('x-device-token') ?? req.header('x-device-secret');

  if (!token) {
    if (env.INGEST_REQUIRE_AUTH) {
      log.warn('ingest rejected: no device credential', {
        event: LogEvent.AUTH_FAILED,
        ip: req.ip,
      });
      next(unauthorized('A device token is required on this endpoint.'));
      return;
    }
    next();
    return;
  }

  void findGatewayByToken(token)
    .then((gateway) => {
      if (!gateway) {
        log.warn('ingest rejected: unrecognised device token', {
          event: LogEvent.AUTH_FAILED,
          ip: req.ip,
        });
        next(unauthorized('Device token was not recognised.'));
        return;
      }
      if (!gateway.enabled) {
        next(forbidden('This gateway is disabled.'));
        return;
      }
      req.gateway = gateway;
      next();
    })
    .catch(next);
}
