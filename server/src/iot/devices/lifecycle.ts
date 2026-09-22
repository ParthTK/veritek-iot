import { env } from '../../config/env.js';
import { newId } from '../../core/hash.js';
import { createLogger } from '../../core/logger.js';
import { nowIso } from '../../core/time.js';
import { db } from '../../db/index.js';
import type { Gateway } from '../../db/repositories/gateways.js';
import { getGateway, getGatewayByUid, upsertGateway } from '../../db/repositories/gateways.js';
import { upsertMeter } from '../../db/repositories/meters.js';
import type { MqttCredential } from '../../db/repositories/mqttCredentials.js';
import {
  issueCredential,
  listCredentials,
  setGatewayCredentialsStatus,
} from '../../db/repositories/mqttCredentials.js';
import { audit } from '../../db/repositories/users.js';
import { applyCredential, applyGatewayStatus, reconcileBroker } from '../mqtt/brokerDirectory.js';
import { deviceAcl, serviceAcl, topicsFor } from '../mqtt/topics.js';

const log = createLogger('devices:lifecycle');

/**
 * Device lifecycle (spec section 33) and provisioning workflow (section 32).
 *
 *   provisioned -> active -> suspended -> active
 *                        \-> revoked
 *                        \-> decommissioned (optionally replaced by a new unit)
 *
 * Two invariants hold throughout:
 *
 *   1. losing access is immediate. Suspending, revoking or decommissioning a
 *      gateway flips its credentials, and the change reaches the broker in the
 *      same request - with EMQX because it asks us on the next CONNECT, with
 *      Mosquitto because the change is pushed and any open session dropped;
 *   2. history is never destroyed. A decommissioned gateway keeps its telemetry
 *      and its raw packets; only its ability to connect goes away.
 */

export type LifecycleState =
  | 'provisioned'
  | 'active'
  | 'suspended'
  | 'revoked'
  | 'decommissioned';

export interface ProvisionInput {
  /** Human-facing id, used in topics and as the MQTT username, e.g. GW-MUM-001. */
  gatewayUid: string;
  name?: string;
  siteId?: string | null;
  hardwareModel?: string | null;
  imei?: string | null;
  simNumber?: string | null;
  environment?: 'staging' | 'production';
  /** Meters on the RS485 bus, by Modbus slave id. */
  meters?: Array<{ slaveId: number; meterName?: string; meterModelId?: string | null }>;
  /** Pin the MQTT client id the device must present. */
  clientIdPattern?: string | null;
  actor?: string | null;
  notes?: string | null;
}

export interface ProvisionResult {
  gateway: Gateway;
  credential: MqttCredential;
  /** Shown once. Not stored, not retrievable, never returned to the frontend. */
  mqttPassword: string;
  topics: ReturnType<typeof topicsFor>;
  /** Everything an installer needs to type into the gateway, minus the secret. */
  connectionProfile: {
    host: string;
    tlsPort: number;
    plainPort: number | null;
    username: string;
    clientId: string;
    telemetryTopic: string;
    statusTopic: string;
    commandTopic: string;
    responseTopic: string;
    qos: number;
    tls: boolean;
  };
}

/**
 * Create a gateway, its meters, its MQTT credential and its ACL in one step.
 *
 * This is the whole of "install another site" - no broker file is edited, no
 * service is reloaded.
 */
export async function provisionGateway(input: ProvisionInput): Promise<ProvisionResult> {
  const existing = await getGatewayByUid(input.gatewayUid);
  if (existing && existing.lifecycleState !== 'provisioned') {
    throw new Error(
      'Gateway ' + input.gatewayUid + ' already exists and is ' + existing.lifecycleState +
        '. Use rotateCredentials or replaceGateway instead of re-provisioning.',
    );
  }

  const gateway = await upsertGateway({
    gatewayUid: input.gatewayUid,
    name: input.name ?? input.gatewayUid,
    siteId: input.siteId ?? null,
    hardwareModel: input.hardwareModel ?? null,
    imei: input.imei ?? null,
    simNumber: input.simNumber ?? null,
    mqttUsername: input.gatewayUid,
    connectionType: 'MQTT',
    topicNamespace: topicsFor(input.gatewayUid).telemetry.replace(/\/telemetry$/, ''),
    enabled: true,
    notes: input.notes ?? null,
  });

  await setLifecycleState(gateway.id, 'provisioned');
  await db().execute('UPDATE gateways SET environment = $2, updated_at = $3 WHERE id = $1', [
    gateway.id,
    input.environment ?? (env.NODE_ENV === 'production' ? 'production' : 'staging'),
    nowIso(),
  ]);

  for (const meter of input.meters ?? []) {
    await upsertMeter({
      meterUid: input.gatewayUid + ':' + meter.slaveId,
      meterName: meter.meterName ?? input.gatewayUid + ' slave ' + meter.slaveId,
      siteId: input.siteId ?? null,
      gatewayId: gateway.id,
      meterModelId: meter.meterModelId ?? null,
      slaveId: meter.slaveId,
      enabled: true,
    });
  }

  const issued = await issueCredential({
    gatewayId: gateway.id,
    gatewayUid: gateway.gatewayUid,
    mqttUsername: gateway.gatewayUid,
    kind: 'device',
    acl: deviceAcl(gateway.gatewayUid),
    clientIdPattern: input.clientIdPattern ?? null,
    createdBy: input.actor ?? null,
    notes: 'Issued at provisioning.',
  });
  // Before the password is handed out: one the broker does not know would not work.
  await applyCredential(issued.credential, issued.password);

  await audit({
    actor: input.actor ?? null,
    action: 'gateway.provision',
    entityType: 'gateway',
    entityId: gateway.id,
    detail: {
      gatewayUid: gateway.gatewayUid,
      meters: (input.meters ?? []).length,
      environment: input.environment ?? null,
    },
  });

  log.info('gateway provisioned', {
    gatewayUid: gateway.gatewayUid,
    meters: (input.meters ?? []).length,
  });

  const refreshed = (await getGateway(gateway.id)) ?? gateway;
  return {
    gateway: refreshed,
    credential: issued.credential,
    mqttPassword: issued.password,
    topics: topicsFor(gateway.gatewayUid),
    connectionProfile: connectionProfileFor(gateway.gatewayUid),
  };
}

/** The non-secret half of a device's connection settings. */
export function connectionProfileFor(gatewayUid: string): ProvisionResult['connectionProfile'] {
  const topics = topicsFor(gatewayUid);
  return {
    host: env.MQTT_PUBLIC_HOST || env.MQTT_HOST,
    tlsPort: env.MQTT_PUBLIC_TLS_PORT,
    // Null unless a commissioning window has deliberately left 1883 open.
    plainPort: env.MQTT_PLAINTEXT_ENABLED ? env.MQTT_PUBLIC_PLAIN_PORT : null,
    username: gatewayUid,
    clientId: gatewayUid,
    telemetryTopic: topics.telemetry,
    statusTopic: topics.status,
    commandTopic: topics.command,
    responseTopic: topics.response,
    qos: env.MQTT_QOS,
    tls: !env.MQTT_PLAINTEXT_ENABLED,
  };
}

/**
 * Carry a credential status change to the broker.
 *
 * The database change has already happened and is the record. If the broker
 * cannot be reached, a full reconciliation is queued rather than failing the
 * request: it re-applies every status on its next pass, so a suspension still
 * lands, only later - and the failure is logged loudly because "later" matters
 * for a compromised device.
 */
async function pushStatus(gatewayId: string): Promise<void> {
  try {
    await applyGatewayStatus(gatewayId);
  } catch (error) {
    log.error('credential status saved but not yet applied at the broker; retrying via reconciliation', {
      gatewayId,
      error,
    });
    setTimeout(() => void reconcileBroker(), 5_000).unref();
  }
}

async function setLifecycleState(gatewayId: string, state: LifecycleState): Promise<void> {
  const now = nowIso();
  await db().execute(
    'UPDATE gateways SET lifecycle_state = $2, updated_at = $3, ' +
      "commissioned_at = CASE WHEN $2 = 'active' AND commissioned_at IS NULL THEN $3 ELSE commissioned_at END, " +
      "decommissioned_at = CASE WHEN $2 = 'decommissioned' THEN $3 ELSE decommissioned_at END " +
      'WHERE id = $1',
    [gatewayId, state, now],
  );
}

/** Mark a gateway commissioned once it has delivered verified telemetry. */
export async function activateGateway(gatewayId: string, actor?: string | null): Promise<Gateway> {
  await setLifecycleState(gatewayId, 'active');
  await setGatewayCredentialsStatus(gatewayId, 'active');
  await pushStatus(gatewayId);
  await db().execute('UPDATE gateways SET enabled = $2, updated_at = $3 WHERE id = $1', [gatewayId, true, nowIso()]);
  await audit({ actor: actor ?? null, action: 'gateway.activate', entityType: 'gateway', entityId: gatewayId });

  const gateway = await getGateway(gatewayId);
  if (!gateway) throw new Error('Unknown gateway ' + gatewayId);
  log.info('gateway activated', { gatewayUid: gateway.gatewayUid });
  return gateway;
}

/** Temporarily block a gateway. Reversible with {@link activateGateway}. */
export async function suspendGateway(
  gatewayId: string,
  reason: string,
  actor?: string | null,
): Promise<Gateway> {
  await setLifecycleState(gatewayId, 'suspended');
  await setGatewayCredentialsStatus(gatewayId, 'suspended', reason);
  await pushStatus(gatewayId);
  await audit({
    actor: actor ?? null,
    action: 'gateway.suspend',
    entityType: 'gateway',
    entityId: gatewayId,
    detail: { reason },
  });

  const gateway = await getGateway(gatewayId);
  if (!gateway) throw new Error('Unknown gateway ' + gatewayId);
  log.warn('gateway suspended', { gatewayUid: gateway.gatewayUid, reason });
  return gateway;
}

/** Permanently block a gateway - a lost or compromised unit. */
export async function revokeGateway(
  gatewayId: string,
  reason: string,
  actor?: string | null,
): Promise<Gateway> {
  await setLifecycleState(gatewayId, 'revoked');
  await setGatewayCredentialsStatus(gatewayId, 'revoked', reason);
  await pushStatus(gatewayId);
  await db().execute('UPDATE gateways SET enabled = $2, updated_at = $3 WHERE id = $1', [gatewayId, false, nowIso()]);
  await audit({
    actor: actor ?? null,
    action: 'gateway.revoke',
    entityType: 'gateway',
    entityId: gatewayId,
    detail: { reason },
  });

  const gateway = await getGateway(gatewayId);
  if (!gateway) throw new Error('Unknown gateway ' + gatewayId);
  log.warn('gateway revoked; broker access removed', { gatewayUid: gateway.gatewayUid, reason });
  return gateway;
}

/** Retire a gateway. Telemetry and raw packets are kept. */
export async function decommissionGateway(gatewayId: string, actor?: string | null): Promise<Gateway> {
  await setLifecycleState(gatewayId, 'decommissioned');
  await setGatewayCredentialsStatus(gatewayId, 'revoked', 'gateway decommissioned');
  await pushStatus(gatewayId);
  await db().execute('UPDATE gateways SET enabled = $2, updated_at = $3 WHERE id = $1', [gatewayId, false, nowIso()]);
  // Meters are disabled, not deleted: their history stays queryable.
  await db().execute('UPDATE meters SET enabled = $2, updated_at = $3 WHERE gateway_id = $1', [
    gatewayId, false, nowIso(),
  ]);
  await audit({ actor: actor ?? null, action: 'gateway.decommission', entityType: 'gateway', entityId: gatewayId });

  const gateway = await getGateway(gatewayId);
  if (!gateway) throw new Error('Unknown gateway ' + gatewayId);
  log.warn('gateway decommissioned; history retained', { gatewayUid: gateway.gatewayUid });
  return gateway;
}

/** Issue a fresh password for a gateway, keeping its identity and history. */
export async function rotateCredentials(
  gatewayId: string,
  actor?: string | null,
): Promise<{ credential: MqttCredential; mqttPassword: string }> {
  const gateway = await getGateway(gatewayId);
  if (!gateway) throw new Error('Unknown gateway ' + gatewayId);

  const issued = await issueCredential({
    gatewayId: gateway.id,
    gatewayUid: gateway.gatewayUid,
    mqttUsername: gateway.mqttUsername ?? gateway.gatewayUid,
    kind: 'device',
    acl: deviceAcl(gateway.gatewayUid),
    createdBy: actor ?? null,
    notes: 'Rotated at ' + nowIso(),
  });
  await applyCredential(issued.credential, issued.password);

  await audit({
    actor: actor ?? null,
    action: 'gateway.credential.rotate',
    entityType: 'gateway',
    entityId: gateway.id,
    detail: { gatewayUid: gateway.gatewayUid },
  });
  log.info('gateway credential rotated', { gatewayUid: gateway.gatewayUid });

  return { credential: issued.credential, mqttPassword: issued.password };
}

/**
 * Swap a failed unit for a new one.
 *
 * The replacement takes over the site and the meters; the old gateway is
 * decommissioned and keeps its telemetry, so the site's history is continuous
 * across the hardware change.
 */
export async function replaceGateway(
  oldGatewayId: string,
  input: ProvisionInput,
  actor?: string | null,
): Promise<ProvisionResult> {
  const old = await getGateway(oldGatewayId);
  if (!old) throw new Error('Unknown gateway ' + oldGatewayId);

  const result = await provisionGateway({
    ...input,
    siteId: input.siteId ?? old.siteId,
    actor: actor ?? null,
  });

  // Move the meters across, keeping their ids so their telemetry stays attached.
  await db().execute('UPDATE meters SET gateway_id = $2, updated_at = $3 WHERE gateway_id = $1', [
    oldGatewayId, result.gateway.id, nowIso(),
  ]);
  await decommissionGateway(oldGatewayId, actor);
  await db().execute('UPDATE gateways SET replaced_by_gateway_id = $2, updated_at = $3 WHERE id = $1', [
    oldGatewayId, result.gateway.id, nowIso(),
  ]);

  await audit({
    actor: actor ?? null,
    action: 'gateway.replace',
    entityType: 'gateway',
    entityId: oldGatewayId,
    detail: { replacedBy: result.gateway.gatewayUid },
  });
  log.warn('gateway replaced', { old: old.gatewayUid, replacement: result.gateway.gatewayUid });

  return result;
}

/**
 * Ensure the backend's own MQTT identity exists (spec section 9).
 *
 * A separate service account with wildcard subscribe rights. It is never a
 * gateway credential, and it is still bound by an ACL rather than being made a
 * broker superuser.
 */
export async function ensureServiceAccount(): Promise<{ username: string; created: boolean; password?: string }> {
  const username = env.MQTT_USERNAME ?? 'energy-backend-ingestion';
  const existing = await listCredentials({ kind: 'service' });
  const match = existing.find((credential) => credential.mqttUsername === username);

  if (match) {
    // Keep the ACL current if the topic root has changed since it was issued.
    const { setCredentialAcl } = await import('../../db/repositories/mqttCredentials.js');
    await setCredentialAcl(match.id, serviceAcl());
    return { username, created: false };
  }

  const issued = await issueCredential({
    mqttUsername: username,
    kind: 'service',
    acl: serviceAcl(),
    // With MQTT_PASSWORD set, the account uses it so the running backend can
    // authenticate; otherwise one is generated and logged once.
    password: env.MQTT_PASSWORD ?? undefined,
    notes: 'Backend ingestion service account. Never issue this to a device.',
  });

  log.info('backend MQTT service account created', { username, aclSubscribe: issued.credential.acl.subscribe });
  return { username, created: true, password: env.MQTT_PASSWORD ? undefined : issued.password };
}

export function newGatewayUid(prefix = 'GW'): string {
  return prefix + '-' + newId('').replace(/^_/, '').slice(0, 8).toUpperCase();
}
