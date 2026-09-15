/**
 * Time handling.
 *
 * Rules the rest of the codebase relies on (spec section 10):
 *   - everything is stored in UTC;
 *   - the measurement time reported by the gateway (`source_timestamp`) is kept
 *     separate from the time the server saw the packet (`server_received_at`);
 *   - conversion to a site's local timezone happens only at the API edge.
 *
 * Gateway clocks are an unknown quantity until the hardware is on the bench, so
 * `parseTimestamp` is deliberately permissive about the shapes it accepts and
 * always reports how it interpreted what it was given.
 */

export type TimestampFormat =
  | 'auto'
  | 'iso'
  | 'epoch_s'
  | 'epoch_ms'
  | 'yyyy-mm-dd hh:mm:ss'
  | 'yyyymmddhhmmss';

export interface ParsedTimestamp {
  /** Instant in UTC. */
  date: Date;
  /** How the raw value was read. */
  format: TimestampFormat;
  /** True when the raw value carried an explicit UTC offset / Z marker. */
  hadOffset: boolean;
  /** Offset (minutes east of UTC) assumed when the raw value carried none. */
  assumedOffsetMinutes: number | null;
}

const ISO_WITH_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;
const NAIVE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/;
const COMPACT_DATETIME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;

/**
 * Convert an offset such as `+05:30`, `+0530`, `330` or `5.5` into minutes east
 * of UTC. Returns null when the input cannot be understood.
 */
export function parseOffsetMinutes(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    // Small magnitudes are hours (IST = 5.5), larger ones are already minutes.
    return Math.abs(input) <= 14 ? Math.round(input * 60) : Math.round(input);
  }
  const trimmed = input.trim();
  if (/^utc$/i.test(trimmed) || trimmed === 'Z' || trimmed === 'z') return 0;
  const match = /^([+-])?(\d{1,2}):?(\d{2})?$/.exec(trimmed);
  if (match) {
    const sign = match[1] === '-' ? -1 : 1;
    const hours = Number(match[2]);
    const minutes = Number(match[3] ?? '0');
    return sign * (hours * 60 + minutes);
  }
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? parseOffsetMinutes(numeric) : null;
}

/**
 * Parse a timestamp coming off a device.
 *
 * @param raw                  value as it appeared in the payload
 * @param format               declared format, or 'auto' to sniff
 * @param assumeOffsetMinutes  offset applied when the value carries no timezone
 *                             information of its own (site/gateway local time)
 */
export function parseTimestamp(
  raw: unknown,
  format: TimestampFormat = 'auto',
  assumeOffsetMinutes = 0,
): ParsedTimestamp | null {
  if (raw === null || raw === undefined) return null;

  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime())
      ? null
      : { date: raw, format: 'iso', hadOffset: true, assumedOffsetMinutes: null };
  }

  if (typeof raw === 'number' || (typeof raw === 'string' && /^\d{9,14}$/.test(raw.trim()))) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    // 14 digits is a compact yyyymmddhhmmss stamp, not an epoch.
    if (text.length === 14 && (format === 'auto' || format === 'yyyymmddhhmmss')) {
      return parseCompact(text, assumeOffsetMinutes);
    }
    const numeric = typeof raw === 'number' ? raw : Number(text);
    if (!Number.isFinite(numeric)) return null;
    const isSeconds = format === 'epoch_s' || (format !== 'epoch_ms' && Math.abs(numeric) < 1e11);
    const date = new Date(isSeconds ? numeric * 1000 : numeric);
    if (Number.isNaN(date.getTime())) return null;
    return {
      date,
      format: isSeconds ? 'epoch_s' : 'epoch_ms',
      hadOffset: true, // epoch values are unambiguous
      assumedOffsetMinutes: null,
    };
  }

  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;

  if (format === 'yyyymmddhhmmss' || COMPACT_DATETIME.test(value)) {
    return parseCompact(value, assumeOffsetMinutes);
  }

  if (ISO_WITH_OFFSET.test(value)) {
    const date = new Date(value.replace(' ', 'T'));
    if (Number.isNaN(date.getTime())) return null;
    return { date, format: 'iso', hadOffset: true, assumedOffsetMinutes: null };
  }

  const naive = NAIVE_DATETIME.exec(value);
  if (naive) {
    const fraction = naive[7] ? Number((naive[7] + '000').slice(0, 3)) : 0;
    return fromNaiveParts(
      Number(naive[1]), Number(naive[2]), Number(naive[3]),
      Number(naive[4]), Number(naive[5]), Number(naive[6] ?? '0'), fraction,
      assumeOffsetMinutes,
      value.includes('T') ? 'iso' : 'yyyy-mm-dd hh:mm:ss',
    );
  }

  const fallback = new Date(value);
  if (!Number.isNaN(fallback.getTime())) {
    return {
      date: fallback,
      format: 'iso',
      hadOffset: false,
      assumedOffsetMinutes: assumeOffsetMinutes,
    };
  }
  return null;
}

function parseCompact(value: string, assumeOffsetMinutes: number): ParsedTimestamp | null {
  const m = COMPACT_DATETIME.exec(value);
  if (!m) return null;
  return fromNaiveParts(
    Number(m[1]), Number(m[2]), Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]), 0,
    assumeOffsetMinutes, 'yyyymmddhhmmss',
  );
}

function fromNaiveParts(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number, ms: number,
  assumeOffsetMinutes: number,
  format: TimestampFormat,
): ParsedTimestamp {
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  return {
    date: new Date(utcMs - assumeOffsetMinutes * 60_000),
    format,
    hadOffset: false,
    assumedOffsetMinutes: assumeOffsetMinutes,
  };
}

/** Canonical storage representation: ISO-8601, UTC, millisecond precision. */
export function toIsoUtc(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/* ------------------------------------------------------- bucket boundaries -- */

export type BucketInterval = '1m' | '5m' | '15m' | '1h' | '1d' | '1mo';

export const BUCKET_INTERVALS: BucketInterval[] = ['1m', '5m', '15m', '1h', '1d', '1mo'];

const FIXED_BUCKET_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
};

export function isBucketInterval(value: string): value is BucketInterval {
  return (BUCKET_INTERVALS as string[]).includes(value);
}

/**
 * Start of the bucket containing `instant`.
 *
 * Sub-daily buckets are plain UTC arithmetic. Daily and monthly buckets follow
 * the *site's* calendar, because "yesterday's kWh" has to mean the local
 * midnight-to-midnight day, not a UTC one.
 */
export function bucketStart(
  instant: Date | string,
  interval: BucketInterval,
  timeZone = 'UTC',
): Date {
  const date = instant instanceof Date ? instant : new Date(instant);
  const fixed = FIXED_BUCKET_MS[interval];
  if (fixed) return new Date(Math.floor(date.getTime() / fixed) * fixed);

  const parts = zonedParts(date, timeZone);
  if (interval === '1d') {
    return zonedToUtc({ ...parts, hour: 0, minute: 0, second: 0 }, timeZone);
  }
  return zonedToUtc({ ...parts, day: 1, hour: 0, minute: 0, second: 0 }, timeZone);
}

/** Start of the bucket after the one containing `instant`. */
export function bucketEnd(
  instant: Date | string,
  interval: BucketInterval,
  timeZone = 'UTC',
): Date {
  const start = bucketStart(instant, interval, timeZone);
  const fixed = FIXED_BUCKET_MS[interval];
  if (fixed) return new Date(start.getTime() + fixed);

  const parts = zonedParts(start, timeZone);
  if (interval === '1d') {
    return zonedToUtc({ ...parts, day: parts.day + 1, hour: 0, minute: 0, second: 0 }, timeZone);
  }
  const rollsOver = parts.month === 12;
  return zonedToUtc(
    {
      ...parts,
      year: rollsOver ? parts.year + 1 : parts.year,
      month: rollsOver ? 1 : parts.month + 1,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone,
  );
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Break a UTC instant into wall-clock parts in `timeZone`. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const hour = read('hour');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: hour === 24 ? 0 : hour,
    minute: read('minute'),
    second: read('second'),
  };
}

/** Offset of `timeZone` at `date`, in minutes east of UTC. */
export function offsetMinutesAt(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour, parts.minute, parts.second,
  );
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/** Inverse of {@link zonedParts}: wall-clock parts in `timeZone` to a UTC instant. */
export function zonedToUtc(parts: ZonedParts, timeZone: string): Date {
  const naiveUtc = Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour, parts.minute, parts.second,
  );
  // Two passes settle DST transitions; India has none, but sites elsewhere will.
  let guess = new Date(naiveUtc - offsetMinutesAt(new Date(naiveUtc), timeZone) * 60_000);
  guess = new Date(naiveUtc - offsetMinutesAt(guess, timeZone) * 60_000);
  return guess;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Render a UTC instant as an ISO-8601 string carrying the site's offset. */
export function toSiteIso(instant: Date | string, timeZone: string): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  const offset = offsetMinutesAt(date, timeZone);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const shifted = new Date(date.getTime() + offset * 60_000);
  return shifted.toISOString().replace(/\.\d{3}Z$/, '').replace('Z', '') + sign + hh + ':' + mm;
}

export function intervalMs(interval: BucketInterval): number {
  switch (interval) {
    case '1m': return 60_000;
    case '5m': return 5 * 60_000;
    case '15m': return 15 * 60_000;
    case '1h': return 3_600_000;
    case '1d': return 86_400_000;
    case '1mo': return 30 * 86_400_000;
  }
}
