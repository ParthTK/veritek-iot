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
  /**
   * Set when the packet was refused outright rather than merely unattributed:
   * an authenticated sender whose payload claims to be a different gateway.
   */
  rejected?: string;
}

export interface ResolveGatewayInput {
  /** Identifier lifted out of the payload body. */
  payloadUid?: string | null;
  /** Identifier asserted by the transport (HTTP device token, MQTT client id). */
  assertedUid?: string | null;
  /**
   * Identity the transport has *proven*: the gateway segment of a topic on our
   * own namespace (the broker's ACL only lets a device publish under its own
   * id), or the gateway behind an HTTP device token. When present it is the
   * only identity that counts.
   */
  verifiedUid?: string | null;
  mqttClientId?: string | null;
  topic?: string | null;
  transport?: 'MQTT' | 'HTTP';
}

export async function resolveGateway(input: ResolveGatewayInput): Promise<GatewayResolution> {
  if (input.verifiedUid) {
    // The payload is written by the device and proves nothing. Letting it name
    // a gateway would undo the broker ACL from inside the message: device A,
    // publishing on its own topic, could file its readings under device B just
    // by writing B's id into the body.
    if (input.payloadUid && input.payloadUid !== input.verifiedUid) {
      log.warn('payload claims a different gateway than the authenticated sender; packet refused', {
        event: LogEvent.UNKNOWN_GATEWAY,
        authenticatedAs: input.verifiedUid,
        payloadClaims: input.payloadUid,
        topic: input.topic,
      });
      return {
        gateway: null,
        provisioned: false,
        matchedBy: null,
        rejected:
          'Payload names gateway ' + input.payloadUid + ' but the sender is authenticated as ' +
          input.verifiedUid + '.',
      };
    }
    const gateway = await getGatewayByUid(input.verifiedUid);
    if (gateway) return { gateway, provisioned: false, matchedBy: input.transport === 'HTTP' ? 'token' : 'topic' };
    // A verified identity with no record falls through to the ordinary path,
    // which auto-provisions it when that is switched on.
  }

  const candidates: Array<{ uid: string; matchedBy: string }> = [];
  if (input.verifiedUid) candidates.push({ uid: input.verifiedUid, matchedBy: 'topic' });
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
