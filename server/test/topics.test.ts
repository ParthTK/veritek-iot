import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aclAllows,
  backendPublishFilters,
  backendSubscriptions,
  deviceAcl,
  gatewayTopicBase,
  parseTopic,
  renderAcl,
  serviceAcl,
  topicFor,
  topicsFor,
} from '../src/iot/mqtt/topics.js';

/**
 * The ACL is the whole of the multi-tenancy guarantee: one leaked credential
 * must not become access to another site's meters. These tests pin that.
 */

const ALPHA = 'GW-MUM-001';
const BETA = 'GW-MUM-002';

test('topics follow the documented convention', () => {
  assert.equal(gatewayTopicBase(ALPHA), 'energy/v1/gateways/GW-MUM-001');
  assert.equal(topicFor(ALPHA, 'telemetry'), 'energy/v1/gateways/GW-MUM-001/telemetry');

  const topics = topicsFor(ALPHA);
  assert.equal(topics.status, 'energy/v1/gateways/GW-MUM-001/status');
  assert.equal(topics.command, 'energy/v1/gateways/GW-MUM-001/command');
  assert.equal(topics.response, 'energy/v1/gateways/GW-MUM-001/response');
});

test('a topic parses back into gateway and kind', () => {
  const parsed = parseTopic('energy/v1/gateways/GW-MUM-001/telemetry');
  assert.equal(parsed.gatewayId, ALPHA);
  assert.equal(parsed.kind, 'telemetry');
  assert.equal(parsed.canonical, true);
});

test('a vendor topic is recognised as not ours', () => {
  const parsed = parseTopic('technode/TN-8623600786286128/data');
  assert.equal(parsed.canonical, false);
  assert.equal(parsed.gatewayId, null);
});

test('a device may publish its own telemetry, status and response', () => {
  const acl = deviceAcl(ALPHA);
  const topics = topicsFor(ALPHA);

  assert.equal(aclAllows(acl.publish, topics.telemetry), true);
  assert.equal(aclAllows(acl.publish, topics.status), true);
  assert.equal(aclAllows(acl.publish, topics.response), true);
  assert.equal(aclAllows(acl.subscribe, topics.command), true);
});

test('a device cannot reach another gateway', () => {
  const acl = deviceAcl(ALPHA);
  const other = topicsFor(BETA);

  assert.equal(aclAllows(acl.publish, other.telemetry), false, 'must not publish as another gateway');
  assert.equal(aclAllows(acl.subscribe, other.command), false, 'must not read another gateway commands');
  assert.equal(aclAllows(acl.subscribe, other.telemetry), false, 'must not read another gateway telemetry');
});

test('a device cannot publish onto its own command topic', () => {
  // Commands flow cloud to device only. A gateway that could publish here
  // could issue configuration changes to itself.
  const acl = deviceAcl(ALPHA);
  assert.equal(aclAllows(acl.publish, topicsFor(ALPHA).command), false);
});

test('wildcards are refused unless a rule is that exact wildcard', () => {
  const acl = deviceAcl(ALPHA);
  assert.equal(aclAllows(acl.subscribe, '#'), false);
  assert.equal(aclAllows(acl.subscribe, 'energy/v1/gateways/+/telemetry'), false);
  assert.equal(aclAllows(acl.subscribe, 'energy/#'), false);
  assert.equal(aclAllows(acl.subscribe, '+/#'), false);
});

test('a device cannot publish outside the namespace at all', () => {
  const acl = deviceAcl(ALPHA);
  assert.equal(aclAllows(acl.publish, 'some/other/tree'), false);
  assert.equal(aclAllows(acl.publish, '$SYS/broker/clients'), false);
});

test('the backend service account is scoped, not unlimited', () => {
  const service = serviceAcl();

  assert.equal(aclAllows(service.subscribe, 'energy/v1/gateways/+/telemetry'), true);
  assert.equal(aclAllows(service.subscribe, 'energy/v1/gateways/+/status'), true);
  assert.equal(aclAllows(service.publish, topicsFor(ALPHA).command), true);

  // Even the privileged account is bound: no whole-tree subscription, and it
  // has no business publishing telemetry as if it were a meter.
  assert.equal(aclAllows(service.subscribe, '#'), false);
  assert.equal(aclAllows(service.publish, topicsFor(ALPHA).telemetry), false);
});

test('backend filters cover exactly the device-to-cloud kinds', () => {
  const subscriptions = backendSubscriptions();
  assert.ok(subscriptions.includes('energy/v1/gateways/+/telemetry'));
  assert.ok(subscriptions.includes('energy/v1/gateways/+/status'));
  assert.ok(subscriptions.includes('energy/v1/gateways/+/response'));
  // The backend publishes commands; it must not subscribe to its own.
  assert.ok(!subscriptions.includes('energy/v1/gateways/+/command'));
  assert.deepEqual(backendPublishFilters(), ['energy/v1/gateways/+/command']);
});

test('stored ACL templates render per gateway', () => {
  const rules = renderAcl(['energy/v1/gateways/{gatewayId}/telemetry'], { gatewayId: ALPHA });
  assert.deepEqual(rules, ['energy/v1/gateways/GW-MUM-001/telemetry']);
  assert.equal(aclAllows(rules, topicsFor(ALPHA).telemetry), true);
  assert.equal(aclAllows(rules, topicsFor(BETA).telemetry), false);
});

test('an empty rule set permits nothing', () => {
  // The default-deny posture: a credential whose ACL failed to load gets no
  // access at all rather than falling open.
  assert.equal(aclAllows([], topicsFor(ALPHA).telemetry), false);
  assert.equal(aclAllows([], '#'), false);
});
