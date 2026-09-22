import { env } from '../../config/env.js';
import { createLogger } from '../../core/logger.js';
import type { MqttCredential } from '../../db/repositories/mqttCredentials.js';
import { listCredentials } from '../../db/repositories/mqttCredentials.js';
import { metrics } from '../../observability/metrics.js';
import {
  aclToDynsec,
  deleteBrokerClient,
  deleteBrokerRole,
  disableBrokerClient,
  ensureRole,
  getBrokerClient,
  isDynsecEnabled,
  listBrokerClients,
  upsertBrokerClient,
} from './dynsec.js';

const log = createLogger('mqtt:directory');

/**
 * Keeps the broker's view of who may connect in step with the database.
 *
 * The database stays the system of record - lifecycle state, ACLs, audit - and
 * the broker holds the verifier it needs to authenticate on its own. Every
 * function here is a no-op unless MQTT_BROKER_AUTH=dynsec: with EMQX (webhook
 * mode) or the embedded development broker, the broker asks the database
 * directly and there is nothing to push.
 *
 * Two paths keep them aligned:
 *
 *   - push: lifecycle changes call applyCredential / applyStatus straight
 *     away, so suspending a device takes effect in the same request;
 *   - reconcile: on startup and on a timer, the whole directory is compared
 *     and corrected. That covers a push that failed while the broker was
 *     restarting, and a credential someone added to the broker by hand.
 */

/** One role per credential, so no two identities ever share an ACL by accident. */
export function roleNameFor(username: string): string {
  return 'veritek-cred-' + username;
}

/** Broker identities this service must never disable or delete. */
function protectedUsernames(): Set<string> {
  const names = new Set<string>(env.MQTT_BROKER_PROTECTED_USERS);
  if (env.MQTT_CONTROL_USERNAME) names.add(env.MQTT_CONTROL_USERNAME);
  return names;
}

/**
 * Push a freshly issued or rotated credential.
 *
 * Throws on failure: a password the broker does not know is a password that
 * does not work, and handing one to an installer is worse than an error.
 */
export async function applyCredential(credential: MqttCredential, password: string): Promise<void> {
  if (!isDynsecEnabled()) return;

  const rolename = roleNameFor(credential.mqttUsername);
  await ensureRole(rolename, aclToDynsec(credential.acl), 'ACL for ' + credential.mqttUsername);
  const outcome = await upsertBrokerClient({
    username: credential.mqttUsername,
    password,
    roles: [rolename],
    textname: credential.gatewayUid ?? credential.mqttUsername,
    clientid: exactClientId(credential.clientIdPattern),
  });

  if (credential.status !== 'active') await applyStatus(credential);
  log.info('credential pushed to broker', { username: credential.mqttUsername, outcome });
}

/**
 * Mirror a credential's status: active clients enabled, suspended ones
 * disabled (and kicked), revoked ones removed.
 */
export async function applyStatus(credential: MqttCredential): Promise<void> {
  if (!isDynsecEnabled()) return;
  if (protectedUsernames().has(credential.mqttUsername)) return;

  if (credential.status === 'revoked') {
    await deleteBrokerClient(credential.mqttUsername);
    await deleteBrokerRole(roleNameFor(credential.mqttUsername));
    log.warn('credential removed from broker', { username: credential.mqttUsername });
    return;
  }

  if (credential.status === 'suspended') {
    await disableBrokerClient(credential.mqttUsername);
    log.warn('credential disabled at broker', { username: credential.mqttUsername });
    return;
  }

  const outcome = await upsertBrokerClient({
    username: credential.mqttUsername,
    roles: [roleNameFor(credential.mqttUsername)],
    textname: credential.gatewayUid ?? credential.mqttUsername,
    clientid: exactClientId(credential.clientIdPattern),
  });
  if (outcome === 'missing') {
    log.error('credential is active in the database but absent from the broker; rotate it to reissue', {
      username: credential.mqttUsername,
    });
  }
}

/** Apply status for every credential of one gateway. */
export async function applyGatewayStatus(gatewayId: string): Promise<void> {
  if (!isDynsecEnabled()) return;
  for (const credential of await listCredentials({ gatewayId })) await applyStatus(credential);
}

/**
 * Only an exact client id can be pinned at the broker; a pattern (anything
 * with a wildcard) is enforced by the webhook path only and ignored here.
 */
function exactClientId(pattern: string | null): string | null {
  if (!pattern || /[*?+#]/.test(pattern)) return null;
  return pattern;
}

/* ---------------------------------------------------------- reconcile -- */

export interface ReconcileReport {
  checked: number;
  created: number;
  updated: number;
  disabled: number;
  removed: number;
  /** Active in the database, absent from the broker: needs a rotation. */
  missing: string[];
  /** Present in the broker, unknown to the database: disabled. */
  unknown: string[];
}

let lastReport: ReconcileReport | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;

export function lastReconcileReport(): ReconcileReport | null {
  return lastReport;
}

/**
 * Compare the broker's directory with the database and correct the broker.
 *
 * The backend's own ingestion account is the one credential whose plaintext
 * we hold (MQTT_PASSWORD, from the secret manager), so it is (re)created with
 * that password every time; that is also what makes a password rotation in
 * the secret manager take effect on the next deploy.
 */
export async function reconcileBroker(): Promise<ReconcileReport | null> {
  if (!isDynsecEnabled() || running) return lastReport;
  running = true;

  const report: ReconcileReport = {
    checked: 0, created: 0, updated: 0, disabled: 0, removed: 0, missing: [], unknown: [],
  };

  try {
    const credentials = await listCredentials();
    const known = new Set(credentials.map((credential) => credential.mqttUsername));
    const guarded = protectedUsernames();

    for (const credential of credentials) {
      report.checked += 1;
      const username = credential.mqttUsername;
      if (guarded.has(username)) continue;

      if (credential.status === 'revoked') {
        if (await getBrokerClient(username)) {
          await applyStatus(credential);
          report.removed += 1;
        }
        continue;
      }

      await ensureRole(roleNameFor(username), aclToDynsec(credential.acl), 'ACL for ' + username);

      const isServiceAccount = credential.kind === 'service' && username === env.MQTT_USERNAME;
      const outcome = await upsertBrokerClient({
        username,
        password: isServiceAccount ? (env.MQTT_PASSWORD ?? undefined) : undefined,
        roles: [roleNameFor(username)],
        textname: credential.gatewayUid ?? username,
        clientid: exactClientId(credential.clientIdPattern),
      });

      if (outcome === 'missing') report.missing.push(username);
      else if (outcome === 'created') report.created += 1;
      else report.updated += 1;

      if (credential.status === 'suspended' && outcome !== 'missing') {
        await disableBrokerClient(username);
        report.disabled += 1;
      }
    }

    // Anything in the broker we did not issue is a way in nobody is watching.
    // Disabled rather than deleted: reversible, and it leaves the evidence.
    for (const username of await listBrokerClients()) {
      if (known.has(username) || guarded.has(username)) continue;
      const client = await getBrokerClient(username);
      if (client && !client.disabled) {
        await disableBrokerClient(username);
        report.disabled += 1;
      }
      report.unknown.push(username);
    }

    metrics.brokerMissingCredentials.set(report.missing.length);
    metrics.brokerUnknownClients.set(report.unknown.length);

    const level = report.missing.length || report.unknown.length ? 'warn' : 'info';
    log[level]('broker directory reconciled', { ...report });
    lastReport = report;
    return report;
  } catch (error) {
    log.error('broker reconciliation failed', { error });
    return lastReport;
  } finally {
    running = false;
  }
}

export function startBrokerReconciler(intervalSeconds = env.MQTT_BROKER_RECONCILE_SECONDS): void {
  if (!isDynsecEnabled() || timer) return;
  timer = setInterval(() => void reconcileBroker(), intervalSeconds * 1000);
  timer.unref();
}

export function stopBrokerReconciler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
