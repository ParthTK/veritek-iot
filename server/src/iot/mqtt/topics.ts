import { env } from '../../config/env.js';
import { renderTemplate, topicMatches } from '../adapters/jsonPath.js';

/**
 * Topic architecture (spec section 7).
 *
 *   energy/v1/gateways/{gatewayId}/telemetry   device -> cloud
 *   energy/v1/gateways/{gatewayId}/status      device -> cloud (retained, LWT)
 *   energy/v1/gateways/{gatewayId}/command     cloud  -> device
 *   energy/v1/gateways/{gatewayId}/response    device -> cloud
 *
 * This is *our* convention, and it is what the ACL is built from. It is not an
 * assumption about the hardware: whether the Technode unit can be configured to
 * publish on an arbitrary topic is unverified until the unit is on the bench.
 *
 * So the consumer subscribes to this namespace *and* to any extra vendor
 * namespaces listed in MQTT_VENDOR_TOPICS. If the gateway turns out to insist
 * on a fixed topic of its own, that topic goes in MQTT_VENDOR_TOPICS and the
 * gateway's ACL is widened to match - configuration, not a code change.
 */

export const TOPIC_VERSION = 'v1';

export type TopicKind = 'telemetry' | 'status' | 'command' | 'response';

export interface TopicSet {
  telemetry: string;
  status: string;
  command: string;
  response: string;
}

function root(): string {
  return env.MQTT_TOPIC_ROOT.replace(/\/+$/, '');
}

/** Base for one gateway, e.g. `energy/v1/gateways/GW-MUM-001`. */
export function gatewayTopicBase(gatewayId: string): string {
  return root() + '/gateways/' + gatewayId;
}

export function topicFor(gatewayId: string, kind: TopicKind): string {
  return gatewayTopicBase(gatewayId) + '/' + kind;
}

export function topicsFor(gatewayId: string): TopicSet {
  return {
    telemetry: topicFor(gatewayId, 'telemetry'),
    status: topicFor(gatewayId, 'status'),
    command: topicFor(gatewayId, 'command'),
    response: topicFor(gatewayId, 'response'),
  };
}

/** Wildcard filters the backend service account subscribes to. */
export function backendSubscriptions(): string[] {
  const base = root() + '/gateways/+';
  return [base + '/telemetry', base + '/status', base + '/response'];
}

/** Wildcard the backend service account may publish commands on. */
export function backendPublishFilters(): string[] {
  return [root() + '/gateways/+/command'];
}

/**
 * Command-response topics in the older vendor shape, kept so a gateway that
 * answers on a sibling of its command topic is still heard.
 */
export function legacyResponseFilters(): string[] {
  if (!env.MQTT_COMMAND_TOPIC) return [];
  const base = env.MQTT_COMMAND_TOPIC.replace(/{gatewayUid}/g, '+');
  return [base + '/response', base + '/ack'];
}

/**
 * Everything the consumer listens to: the v1 namespace, plus any vendor-shaped
 * namespace still in play (during commissioning, or for a gateway whose topic
 * is not configurable), plus anything explicitly configured.
 */
export function consumerSubscriptions(): string[] {
  const filters = new Set<string>(backendSubscriptions());
  for (const filter of env.MQTT_VENDOR_TOPICS) filters.add(filter);
  for (const filter of env.MQTT_SUBSCRIBE_TOPICS) filters.add(filter);
  for (const filter of legacyResponseFilters()) filters.add(filter);
  return [...filters];
}

export interface ParsedTopic {
  gatewayId: string | null;
  kind: TopicKind | null;
  /** True when the topic follows our own convention rather than a vendor one. */
  canonical: boolean;
}

/** Pull the gateway id and message kind out of a topic on our namespace. */
export function parseTopic(topic: string): ParsedTopic {
  const prefix = root() + '/gateways/';
  if (!topic.startsWith(prefix)) return { gatewayId: null, kind: null, canonical: false };

  const rest = topic.slice(prefix.length).split('/');
  const gatewayId = rest[0] ?? null;
  const tail = rest[1] ?? null;
  const kind: TopicKind | null =
    tail === 'telemetry' || tail === 'status' || tail === 'command' || tail === 'response' ? tail : null;

  return { gatewayId: gatewayId || null, kind, canonical: Boolean(gatewayId && kind) };
}

/* ---------------------------------------------------------------- ACLs -- */

export interface AclSpec {
  publish: string[];
  subscribe: string[];
}

/**
 * The ACL a physical gateway gets (spec section 8).
 *
 * Publish only its own telemetry/status/response, subscribe only to its own
 * command topic. It cannot read another gateway, publish as another gateway, or
 * subscribe to a wildcard.
 */
export function deviceAcl(gatewayId: string, extraPublish: string[] = []): AclSpec {
  const topics = topicsFor(gatewayId);
  return {
    publish: [topics.telemetry, topics.status, topics.response, ...extraPublish],
    subscribe: [topics.command],
  };
}

/**
 * The ACL for the backend's own ingestion account (spec section 9).
 *
 * Derived from consumerSubscriptions() rather than listed separately. When the
 * two were maintained apart, the consumer subscribed to a vendor namespace the
 * ACL did not grant; with deny_action = disconnect that is not a warning, it is
 * the broker dropping the backend in a reconnect loop.
 */
export function serviceAcl(): AclSpec {
  return {
    publish: backendPublishFilters(),
    subscribe: consumerSubscriptions(),
  };
}

/**
 * Check a topic against an ACL list.
 *
 * MQTT wildcards are honoured on the *rule* side only: a rule may say
 * `energy/v1/gateways/+/telemetry`, but a device asking to subscribe to a
 * wildcard is matched literally against its rules and therefore denied, which
 * is exactly the behaviour section 8 asks us to prove.
 */
export function aclAllows(rules: string[], topic: string): boolean {
  if (topic.includes('#') || topic.includes('+')) {
    // A wildcard request is only ever granted if a rule is that same wildcard.
    return rules.includes(topic);
  }
  return rules.some((rule) => topicMatches(rule, topic));
}

/** Fill `{gatewayId}` / `{gatewayUid}` in a stored ACL rule. */
export function renderAcl(rules: string[], values: Record<string, string | number | null>): string[] {
  return rules.map((rule) => renderTemplate(rule, values));
}
