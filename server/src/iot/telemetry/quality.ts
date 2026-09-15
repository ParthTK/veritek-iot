import type { MetricDefinition } from '../../db/repositories/metrics.js';
import type { Quality } from '../adapters/types.js';

/**
 * Plausibility checks on an individual value.
 *
 * The rule from spec section 13 applies throughout: an odd reading is stored
 * with a quality flag, never dropped and never quietly corrected. Losing a real
 * brownout because it looked wrong is worse than carrying a flagged sample.
 */

export interface QualityAssessment {
  quality: Quality;
  reason: string | null;
}

export function assessValue(
  value: number,
  definition: MetricDefinition | null,
  incoming: Quality = 'GOOD',
): QualityAssessment {
  if (!Number.isFinite(value)) {
    return { quality: 'BAD', reason: 'Value is not a finite number.' };
  }
  if (!definition) {
    return { quality: incoming, reason: null };
  }

  if (definition.minValid !== null && value < definition.minValid) {
    return {
      quality: 'SUSPECT',
      reason: 'Below the plausible minimum for ' + definition.metricKey + ' (' + definition.minValid + ').',
    };
  }
  if (definition.maxValid !== null && value > definition.maxValid) {
    return {
      quality: 'SUSPECT',
      reason: 'Above the plausible maximum for ' + definition.metricKey + ' (' + definition.maxValid + ').',
    };
  }
  return { quality: incoming, reason: null };
}

/** The worse of two quality flags, for rolling several samples into one. */
export function worseQuality(a: Quality, b: Quality): Quality {
  const rank: Record<Quality, number> = { GOOD: 0, ESTIMATED: 1, STALE: 2, SUSPECT: 3, BAD: 4 };
  return rank[a] >= rank[b] ? a : b;
}
