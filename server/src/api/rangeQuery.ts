import type { Request } from 'express';
import { badRequest } from '../core/errors.js';

/**
 * Parse `?from=&to=` into a UTC window.
 *
 * Accepts ISO-8601 (with or without offset), epoch milliseconds, and relative
 * shorthands such as `-24h`, `-7d`, `-30m` or `now`, which keep dashboard URLs
 * shareable without a date picker.
 */
export interface TimeRange {
  from: string;
  to: string;
}

const RELATIVE = /^-(\d+)(s|m|h|d|w)$/i;

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function parseInstant(value: string | undefined, fallback: number): number {
  if (!value || value.trim() === '') return fallback;
  const trimmed = value.trim();

  if (/^now$/i.test(trimmed)) return Date.now();

  const relative = RELATIVE.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = (relative[2] ?? 'h').toLowerCase();
    return Date.now() - amount * (UNIT_MS[unit] ?? UNIT_MS.h ?? 3_600_000);
  }

  if (/^\d{10,14}$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return trimmed.length <= 11 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) throw badRequest('Could not parse the timestamp "' + value + '".');
  return parsed;
}

export function parseRange(req: Request, defaultSpanMs = 86_400_000): TimeRange {
  const to = parseInstant(stringParam(req, 'to'), Date.now());
  const from = parseInstant(stringParam(req, 'from'), to - defaultSpanMs);
  if (from > to) throw badRequest('`from` must be earlier than `to`.');
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

export function stringParam(req: Request, name: string): string | undefined {
  const value = req.query[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

export function listParam(req: Request, name: string): string[] | undefined {
  const value = stringParam(req, name);
  if (!value) return undefined;
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

export function intParam(req: Request, name: string, fallback: number): number {
  const value = stringParam(req, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function boolParam(req: Request, name: string, fallback = false): boolean {
  const value = stringParam(req, name);
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

/** Express types path params loosely; this narrows one to a string. */
export function pathParam(req: Request, name: string): string {
  const value = (req.params as Record<string, unknown>)[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  throw badRequest('Missing path parameter: ' + name);
}
