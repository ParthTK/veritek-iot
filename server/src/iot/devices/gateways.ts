import { env } from '../../config/env.js';
import { LogEvent } from '../../core/logEvents.js';
import { createLogger } from '../../core/logger.js';
import { nowIso } from '../../core/time.js';
import type { Gateway } from '../../db/repositories/gateways.js';
import { getGatewayByUid, upsertGateway } from '../../db/repositories/gateways.js';

const log = createLogger('devices:gateways');

/**
 * Gateway identity resolution.
 *
 * How a gateway identifies itself in its payload - `gateway_id`, IMEI,
 * MQTT client id, or something else entirely - is one of the four unknowns
 * until the hardware connects. Rather than betting on one, we resolve against
 * whichever identifier the packet actually carried and record what we used.
 */

export interface GatewayResolution {
  gateway: Gateway | null;
  /** True when this call created the record. */
  provisioned: boolean;
  /** Which identifier matched: 'uid' | 'client-id' | 'topic' | 'token'. */
  matchedBy: string | null;
}

export interface ResolveGatewayInput {
  /** Identifier lifted out of the payload body. */
  payloadUid?: string | null;
  /** Identifier asserted by the transport (HTTP device token, MQTT client id). */
  assertedUid?: string | null;
  mqttClientId?: string | null;
  topic?: string | null;
  transport?: 'MQTT' | 'HTTP';
}

export async function resolveGateway(input: ResolveGatewayInput): Promise<GatewayResolution> {
  const candidates: Array<{ uid: string; matchedBy: string }> = [];
  if (input.payloadUid) candidates.push({ uid: input.payloadUid, matchedBy: 'payload' });
  if (input.assertedUid) candidates.push({ uid: input.assertedUid, matchedBy: 'token' });
  if (input.mqttClientId) candidates.push({ uid: input.mqttClientId, matchedBy: 'client-id' });

  for (const candidate of candidates) {
    const gateway = await getGatewayByUid(candidate.uid);
    if (gateway) return { gateway, provisioned: false, matchedBy: candidate.matchedBy };
  }

  const uid = candidates[0]?.uid ?? null;
  if (!uid) {
    log.warn('packet carried no usable gateway identifier', {
      event: LogEvent.UNKNOWN_GATEWAY,
      topic: input.topic,
      transport: input.transport,
    });
    return { gateway: null, provisioned: false, matchedBy: null };
  }

  if (!env.AUTO_PROVISION_GATEWAYS) {
    log.warn('unknown gateway and auto-provisioning is off', {
      event: LogEvent.UNKNOWN_GATEWAY,
      gatewayUid: uid,
      topic: input.topic,
    });
    return { gateway: null, provisioned: false, matchedBy: null };
  }

  // Commissioning convenience: a device we have never seen gets a record so its
  // packets are attributable immediately. It lands with no site and no meters,
  // which is what the commissioning screen highlights for an operator to finish.
  const gateway = await upsertGateway({
    gatewayUid: uid,
    name: uid,
    mqttClientId: input.mqttClientId ?? null,
    connectionType: input.transport ?? null,
    topicNamespace: input.topic ? deriveNamespace(input.topic) : null,
    notes: 'Auto-provisioned on first contact at ' + nowIso() + '. Assign a site and confirm its meters.',
  });

  log.info('auto-provisioned a previously unknown gateway', {
    event: LogEvent.UNKNOWN_GATEWAY,
    gatewayUid: uid,
    gatewayId: gateway.id,
    topic: input.topic,
  });
  return { gateway, provisioned: true, matchedBy: candidates[0]?.matchedBy ?? null };
}

/**
 * Topic prefix a gateway should be confined to, derived from where it actually
 * published. `veritek/GW001/telemetry` yields `veritek/GW001`, which becomes
 * its MQTT ACL scope.
 */
export function deriveNamespace(topic: string): string {
  const parts = topic.split('/');
  return parts.length <= 1 ? topic : parts.slice(0, parts.length - 1).join('/');
}
