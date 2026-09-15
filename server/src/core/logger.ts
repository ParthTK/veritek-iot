import { inspect } from 'node:util';
import type { LogEventCode } from './logEvents.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

/**
 * Keys whose values are never written to a log line, at any depth. MQTT and
 * device credentials pass through this process constantly; section 18 of the
 * spec requires that they never reach a log sink.
 */
const SECRET_KEY_PATTERN =
  /(pass(word|wd)?|secret|token|authorization|auth|apikey|api_key|credential|private[_-]?key|passphrase|sim_?pin|psk)/i;

const REDACTED = '[redacted]';

let currentLevel: LogLevel = 'info';
let pretty = true;

export function configureLogger(options: { level?: LogLevel; pretty?: boolean }): void {
  if (options.level) currentLevel = options.level;
  if (typeof options.pretty === 'boolean') pretty = options.pretty;
}

/** Deep-clone `value`, replacing anything that looks like a credential. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Buffer.isBuffer(value)) return '[buffer ' + value.length + 'B]';
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(val, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Strip credentials out of a connection string before it is logged, e.g.
 * `mqtts://user:hunter2@broker:8883` becomes `mqtts://user:[redacted]@broker:8883`.
 */
export function redactUrl(url: string | undefined | null): string {
  if (!url) return '';
  return url.replace(/(\/\/[^:/?#]+):([^@/?#]+)@/, '$1:[redacted]@');
}

export interface LogFields {
  event?: LogEventCode | string;
  [key: string]: unknown;
}

const CSI = String.fromCharCode(27) + '[';
const COLOURS: Record<LogLevel, string> = {
  trace: CSI + '90m',
  debug: CSI + '36m',
  info: CSI + '32m',
  warn: CSI + '33m',
  error: CSI + '31m',
};
const RESET = CSI + '0m';
const DIM = CSI + '90m';
const BOLD = CSI + '1m';

function emit(level: LogLevel, scope: string, message: string, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;

  const time = new Date().toISOString();
  const safe = (fields ? (redact(fields) as Record<string, unknown>) : {}) ?? {};
  const event = typeof safe.event === 'string' ? safe.event : undefined;
  delete safe.event;

  if (!pretty) {
    writeLine(level, JSON.stringify({ time, level, scope, event, msg: message, ...safe }));
    return;
  }

  const eventTag = event ? ' ' + BOLD + event + RESET : '';
  const rest = Object.keys(safe).length
    ? ' ' + DIM + inspect(safe, { depth: 4, colors: false, breakLength: 160, compact: true }) + RESET
    : '';
  writeLine(
    level,
    DIM + time.slice(11, 23) + RESET +
      ' ' + COLOURS[level] + level.toUpperCase().padEnd(5) + RESET +
      ' ' + DIM + '[' + scope + ']' + RESET +
      eventTag + ' ' + message + rest,
  );
}

function writeLine(level: LogLevel, line: string): void {
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export interface Logger {
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    trace: (m, f) => emit('trace', scope, m, f),
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
    child: (sub) => createLogger(scope + ':' + sub),
  };
}

export const rootLogger = createLogger('app');
