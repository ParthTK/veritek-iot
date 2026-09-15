import type { ObservedPath } from './types.js';

/**
 * Tolerant JSON navigation.
 *
 * Every lookup in the ingest path goes through here because we are reading
 * documents whose shape is not known yet. Nothing throws; a miss is `undefined`
 * and the caller decides what that means.
 */

/** `a.b[0].c` -> ['a', 'b', '0', 'c'] */
export function splitPath(path: string): string[] {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
}

export function getByPath(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of splitPath(path)) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Case- and separator-insensitive property lookup: `gateway_id`, `gatewayId`
 * and `GatewayID` all resolve to the same field.
 */
function looseGet(source: Record<string, unknown>, key: string): unknown {
  if (key in source) return source[key];
  const wanted = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [actual, value] of Object.entries(source)) {
    if (actual.toLowerCase().replace(/[^a-z0-9]/g, '') === wanted) return value;
  }
  return undefined;
}

/** {@link getByPath}, but each segment is matched loosely. */
export function getByPathLoose(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of splitPath(path)) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = looseGet(current as Record<string, unknown>, segment);
  }
  return current;
}

export interface PathHit {
  path: string;
  value: unknown;
}

/** First candidate path that resolves to something other than null/undefined. */
export function firstHit(source: unknown, candidates: string[] | undefined): PathHit | null {
  if (!candidates?.length) return null;
  for (const candidate of candidates) {
    const value = getByPathLoose(source, candidate);
    if (value !== undefined && value !== null && value !== '') {
      return { path: candidate, value };
    }
  }
  return null;
}

/**
 * Deep search for the first key matching one of `names`, to a bounded depth.
 *
 * Only used in auto-discovery, when no payload profile has claimed the message
 * yet. It is a commissioning convenience - the answer is always reported as a
 * guess, never promoted to a verified mapping.
 */
export function findKeyAnywhere(
  source: unknown,
  names: string[],
  maxDepth = 4,
): PathHit | null {
  const wanted = new Set(names.map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, '')));

  const walk = (node: unknown, prefix: string, depth: number): PathHit | null => {
    if (depth > maxDepth || node === null || typeof node !== 'object') return null;

    if (Array.isArray(node)) {
      for (let index = 0; index < Math.min(node.length, 20); index += 1) {
        const hit = walk(node[index], prefix + '[' + index + ']', depth + 1);
        if (hit) return hit;
      }
      return null;
    }

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? prefix + '.' + key : key;
      if (wanted.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) {
        if (value !== null && value !== undefined && value !== '') return { path, value };
      }
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? prefix + '.' + key : key;
      const hit = walk(value, path, depth + 1);
      if (hit) return hit;
    }
    return null;
  };

  return walk(source, '', 0);
}

/**
 * Every leaf path in a document, with its type and a truncated sample.
 *
 * Feeds `payload_field_observations`, which is how the commissioning screen can
 * show the real key names the device uses without anyone reading raw JSON.
 */
export function flattenPaths(source: unknown, maxPaths = 400): ObservedPath[] {
  const out: ObservedPath[] = [];

  const walk = (node: unknown, prefix: string, depth: number): void => {
    if (out.length >= maxPaths || depth > 8) return;

    if (node === null || node === undefined) {
      out.push({ path: prefix || '$', valueType: 'null', sample: 'null' });
      return;
    }
    if (Array.isArray(node)) {
      if (node.length === 0) {
        out.push({ path: prefix || '$', valueType: 'array', sample: '[]' });
        return;
      }
      // Arrays of samples repeat the same shape; recording the first two
      // elements is enough to describe it without flooding the table.
      for (let index = 0; index < Math.min(node.length, 2); index += 1) {
        walk(node[index], prefix + '[' + index + ']', depth + 1);
      }
      return;
    }
    if (typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        walk(value, prefix ? prefix + '.' + key : key, depth + 1);
      }
      return;
    }
    out.push({
      path: prefix || '$',
      valueType: typeof node,
      sample: String(node).slice(0, 120),
    });
  };

  walk(source, '', 0);
  return out;
}

/** Does `topic` match an MQTT filter using `+` and `#` wildcards? */
export function topicMatches(filter: string, topic: string): boolean {
  const filterParts = filter.split('/');
  const topicParts = topic.split('/');

  for (let index = 0; index < filterParts.length; index += 1) {
    const part = filterParts[index];
    if (part === '#') return true;
    if (index >= topicParts.length) return false;
    if (part === '+') continue;
    if (part !== topicParts[index]) return false;
  }
  return filterParts.length === topicParts.length;
}

/** Fill `{placeholders}` in a topic or template string. */
export function renderTemplate(template: string, values: Record<string, string | number | null>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === null || value === undefined ? match : String(value);
  });
}
