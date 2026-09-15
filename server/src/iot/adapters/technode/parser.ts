import { createLogger } from '../../../core/logger.js';
import { LogEvent } from '../../../core/logEvents.js';
import type { PayloadProfile, ProfileMatchRules, ProfileSpec } from '../../../db/repositories/profiles.js';
import { flattenPaths, getByPathLoose, topicMatches } from '../jsonPath.js';
import { parseWithProfile } from '../profileParser.js';
import { DISCOVERY_SPEC } from './discovery.js';
import type { AdapterResult, ParsedPacket, PayloadContext } from '../types.js';

const log = createLogger('adapter:technode');

/**
 * TechnodePayloadAdapter
 *
 * WHAT IS KNOWN: the unit speaks JSON over MQTT or HTTP, polls energy meters
 * over RS485 Modbus RTU, can address several slaves on the same bus, carries an
 * RTC, and buffers readings while the cellular link is down.
 *
 * WHAT IS NOT KNOWN: the production JSON schema and the topic format. The
 * manufacturer does not publish them.
 *
 * So this adapter contains no Technode field names. It runs whichever
 * `payload_profiles` row matches the message. When none matches it falls back
 * to a clearly-labelled discovery pass whose only job is to keep the consumer
 * alive, record what arrived, and flag the packet UNKNOWN_SCHEMA so a human can
 * map it (spec section 19).
 *
 * Tomorrow's commissioning step is therefore: capture the first real packet,
 * read its key names off the commissioning screen, save a `technode_schema_v1`
 * profile row. No redeploy.
 */
export class TechnodePayloadAdapter {
  readonly name = 'technode';

  constructor(private readonly profiles: PayloadProfile[]) {}

  /**
   * The adapter accepts any JSON object or array. Narrowing this would mean
   * asserting something about Technode's schema that we cannot yet assert.
   */
  canHandle(payload: unknown): boolean {
    return payload !== null && typeof payload === 'object';
  }

  parse(payload: unknown, context: PayloadContext): AdapterResult {
    const observedPaths = flattenPaths(payload);

    if (payload === null || typeof payload !== 'object') {
      return {
        status: 'INVALID_PAYLOAD',
        adapter: this.name,
        profileId: null,
        profileName: null,
        packets: [],
        warnings: [],
        error: 'Payload was not a JSON object or array.',
        observedPaths,
      };
    }

    const profile = this.selectProfile(payload, context);

    if (profile) {
      const result = parseWithProfile(payload, profile.spec, {
        defaultOffsetMinutes: context.defaultOffsetMinutes,
        assertedGatewayUid: context.assertedGatewayUid,
      });
      const usable = result.packets.filter(hasSomethingToStore);
      return {
        status: usable.length === 0 ? 'UNKNOWN_SCHEMA' : usable.length === result.packets.length ? 'OK' : 'PARTIAL',
        adapter: this.name,
        profileId: profile.id,
        profileName: profile.name,
        packets: usable,
        warnings: result.warnings,
        error: usable.length === 0 ? 'Profile ' + profile.name + ' matched but extracted no measurements.' : undefined,
        observedPaths,
      };
    }

    return this.discover(payload, context, observedPaths);
  }

  /** Highest-priority enabled profile whose match rules the payload satisfies. */
  private selectProfile(payload: unknown, context: PayloadContext): PayloadProfile | null {
    for (const profile of this.profiles) {
      if (!profile.enabled) continue;
      if (matchesRules(profile.matchRules, payload, context)) return profile;
    }
    return null;
  }

  /**
   * Last-resort structural read of an unrecognised payload.
   *
   * Explicitly a guess. Whatever it manages to extract is reported as
   * UNKNOWN_SCHEMA so that nothing downstream mistakes it for a verified
   * mapping, and the raw bytes are already safe in `raw_iot_messages`.
   */
  private discover(
    payload: unknown,
    context: PayloadContext,
    observedPaths: AdapterResult['observedPaths'],
  ): AdapterResult {
    const result = parseWithProfile(payload, DISCOVERY_SPEC, {
      defaultOffsetMinutes: context.defaultOffsetMinutes,
      assertedGatewayUid: context.assertedGatewayUid,
    });
    const usable = result.packets.filter(hasSomethingToStore);

    log.warn('payload did not match any configured profile', {
      event: LogEvent.UNKNOWN_SCHEMA,
      topic: context.topic,
      transport: context.transport,
      gatewayUid: context.assertedGatewayUid,
      discoveredPackets: usable.length,
      topLevelKeys: Object.keys(payload as Record<string, unknown>).slice(0, 25),
    });

    return {
      status: 'UNKNOWN_SCHEMA',
      adapter: this.name,
      profileId: null,
      profileName: null,
      packets: usable,
      warnings: [
        'No payload profile matched this message; values below were inferred structurally and are NOT a verified mapping.',
        ...result.warnings,
      ],
      error: 'No payload profile matched. Create one from the observed fields to promote this gateway to OK.',
      observedPaths,
    };
  }
}

function hasSomethingToStore(packet: ParsedPacket): boolean {
  return (
    Object.keys(packet.values).length > 0 ||
    packet.registerBlocks.length > 0 ||
    packet.registerValues.length > 0
  );
}

export function matchesRules(
  rules: ProfileMatchRules,
  payload: unknown,
  context: PayloadContext,
): boolean {
  if (rules.topics?.length) {
    const topic = context.topic;
    if (!topic) return false;
    if (!rules.topics.some((filter) => topicMatches(filter, topic))) return false;
  }

  if (rules.gatewayUids?.length) {
    const uid = context.assertedGatewayUid;
    if (!uid || !rules.gatewayUids.includes(uid)) return false;
  }

  if (rules.requiredPaths?.length) {
    for (const path of rules.requiredPaths) {
      const value = getByPathLoose(payload, path);
      if (value === undefined || value === null) return false;
    }
  }

  if (rules.equals) {
    for (const [path, expected] of Object.entries(rules.equals)) {
      const actual = getByPathLoose(payload, path);
      if (String(actual) !== String(expected)) return false;
    }
  }

  // A profile with no rules at all is a catch-all, which is legitimate once a
  // single gateway model is in production.
  return true;
}

export type { ProfileSpec };
