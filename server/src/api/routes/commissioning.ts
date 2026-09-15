import express from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { badRequest, notFound } from '../../core/errors.js';
import { parseOffsetMinutes } from '../../core/time.js';
import { getGateway, getGatewayHealth, listGateways } from '../../db/repositories/gateways.js';
import { getMeterModel, listMeters, listRegisterMap } from '../../db/repositories/meters.js';
import { listMetricDefinitions } from '../../db/repositories/metrics.js';
import { listFieldObservations, listProfiles } from '../../db/repositories/profiles.js';
import type { RawMessage } from '../../db/repositories/rawMessages.js';
import { getRawMessage, listObservedTopics, listRawMessages } from '../../db/repositories/rawMessages.js';
import { getSite } from '../../db/repositories/sites.js';
import { latestByMeter } from '../../db/repositories/telemetry.js';
import { parsePayload } from '../../iot/adapters/registry.js';
import { suggestMetric } from '../../iot/adapters/technode/discovery.js';
import { brokerStatus, devCredentials } from '../../iot/mqtt/broker.js';
import { connectionState } from '../../iot/mqtt/client.js';
import { consumerStats } from '../../iot/mqtt/consumer.js';
import { classifyGateway } from '../../iot/health/monitor.js';
import { processRawMessage } from '../../iot/telemetry/processor.js';
import { requireRole } from '../middleware/auth.js';
import { intParam, pathParam, stringParam } from '../rangeQuery.js';

/**
 * Commissioning APIs (spec section 24).
 *
 * The workflow these are built for, on the day the hardware lands:
 *
 *   1. power the gateway, point it at our broker;
 *   2. watch /topics and /raw until the first packet appears;
 *   3. read the real field names off /gateways/:id (field observations);
 *   4. try a mapping with /test-parse until it extracts what you expect;
 *   5. save it as a payload profile, replay the stored packets, done.
 *
 * No redeploy anywhere in that list.
 */
export function createCommissioningRouter(): express.Router {
  const router = express.Router();

  /** Everything an operator needs on one screen. */
  router.get('/overview', async (_req, res) => {
    const gateways = await listGateways();
    const meters = await listMeters();
    const observations = await listFieldObservations();
    const recent = await listRawMessages({ limit: 10 });

    const rows = await Promise.all(
      gateways.map(async (gateway) => {
        const gatewayMeters = meters.filter((meter) => meter.gatewayId === gateway.id);
        const site = gateway.siteId ? await getSite(gateway.siteId) : null;
        const lastRaw = await listRawMessages({ gatewayUid: gateway.gatewayUid, limit: 1 });
        const health = await getGatewayHealth(gateway.id);

        return {
          gateway: {
            id: gateway.id,
            gatewayUid: gateway.gatewayUid,
            name: gateway.name,
            hardwareModel: gateway.hardwareModel,
            firmwareVersion: gateway.firmwareVersion,
            imei: gateway.imei,
            simNumber: gateway.simNumber,
            connectionType: gateway.connectionType,
            observedTopic: gateway.observedTopic,
            topicNamespace: gateway.topicNamespace,
            payloadProfileId: gateway.payloadProfileId,
            enabled: gateway.enabled,
            lastSeenAt: gateway.lastSeenAt,
            lastDataAt: gateway.lastDataAt,
            status: classifyGateway(gateway.lastSeenAt),
          },
          site: site ? { id: site.id, name: site.name, timezone: site.timezone } : null,
          health,
          latestRawMessage: lastRaw.rows[0] ?? null,
          meters: await Promise.all(
            gatewayMeters.map(async (meter) => ({
              id: meter.id,
              meterUid: meter.meterUid,
              meterName: meter.meterName,
              slaveId: meter.slaveId,
              baudRate: meter.baudRate,
              parity: meter.parity,
              stopBits: meter.stopBits,
              dataBits: meter.dataBits,
              pollIntervalSeconds: meter.pollIntervalSeconds,
              status: meter.status,
              lastDataAt: meter.lastDataAt,
              model: meter.meterModelId ? await getMeterModel(meter.meterModelId) : null,
              registerCount: meter.meterModelId ? (await listRegisterMap(meter.meterModelId)).length : 0,
              latestReadings: await latestByMeter(meter.id),
            })),
          ),
          unmappedFields: observations
            .filter((observation) => observation.gatewayUid === gateway.gatewayUid && !observation.mappedMetric)
            .map((observation) => ({
              ...observation,
              suggestedMetric: suggestMetric(lastSegment(observation.jsonPath)),
            })),
        };
      }),
    );

    res.json({
      generatedAt: new Date().toISOString(),
      mqtt: {
        ...connectionState(),
        consumer: consumerStats(),
        embeddedBroker: brokerStatus(),
        subscribeTopics: env.MQTT_SUBSCRIBE_TOPICS,
        commandTopicTemplate: env.MQTT_COMMAND_TOPIC,
        statusTopicTemplate: env.MQTT_STATUS_TOPIC,
        // Only present when the embedded development broker generated them.
        developmentCredentials: devCredentials(),
      },
      observedTopics: await listObservedTopics(25),
      recentMessages: recent.rows.map(summariseRaw),
      profiles: (await listProfiles(true)).map((profile) => ({
        id: profile.id,
        name: profile.name,
        vendor: profile.vendor,
        enabled: profile.enabled,
        verified: profile.verified,
        priority: profile.priority,
      })),
      gateways: rows,
      openQuestions: OPEN_QUESTIONS,
    });
  });

  /** Topics seen on the broker - how the real topic gets discovered. */
  router.get('/topics', async (req, res) => {
    res.json({
      subscribed: env.MQTT_SUBSCRIBE_TOPICS,
      observed: await listObservedTopics(intParam(req, 'limit', 50)),
      consumer: consumerStats(),
    });
  });

  /** The raw packet log. */
  router.get('/raw', async (req, res) => {
    const result = await listRawMessages({
      gatewayUid: stringParam(req, 'gatewayUid'),
      topic: stringParam(req, 'topic'),
      status: stringParam(req, 'status') as never,
      transport: stringParam(req, 'transport') as never,
      limit: intParam(req, 'limit', 25),
      offset: intParam(req, 'offset', 0),
    });
    res.json({ total: result.total, messages: result.rows.map(summariseRaw) });
  });

  /** One packet, complete and unmodified. */
  router.get('/raw/:id', async (req, res) => {
    const message = await getRawMessage(pathParam(req, 'id'));
    if (!message) throw notFound('No raw message with id ' + pathParam(req, 'id'));
    res.json({ message });
  });

  /** Re-run a stored packet through the pipeline after fixing a mapping. */
  router.post('/raw/:id/replay', requireRole('Operator'), async (req, res) => {
    const message = await getRawMessage(pathParam(req, 'id'));
    if (!message) throw notFound('No raw message with id ' + pathParam(req, 'id'));
    const result = await processRawMessage(message.id);
    res.json({ rawMessageId: message.id, result });
  });

  /**
   * Dry-run a payload against the current profiles without storing anything.
   *
   * This is the fastest route from "here is the first real packet" to a working
   * mapping: paste it, see exactly what the adapter extracts, adjust, repeat.
   */
  router.post('/test-parse', async (req, res) => {
    const schema = z.object({
      payload: z.unknown(),
      topic: z.string().nullish(),
      gatewayUid: z.string().nullish(),
      transport: z.enum(['MQTT', 'HTTP']).optional(),
      profileId: z.string().nullish(),
    });
    const input = schema.parse(req.body);

    let payload = input.payload;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch (error) {
        throw badRequest('payload was a string but not valid JSON: ' + (error as Error).message);
      }
    }
    if (payload === null || typeof payload !== 'object') {
      throw badRequest('payload must be a JSON object or array.');
    }

    const result = await parsePayload(
      payload,
      {
        transport: input.transport ?? 'MQTT',
        topic: input.topic ?? null,
        mqttClientId: null,
        assertedGatewayUid: input.gatewayUid ?? null,
        receivedAt: new Date().toISOString(),
        defaultOffsetMinutes: parseOffsetMinutes(env.DEFAULT_SOURCE_UTC_OFFSET) ?? 0,
      },
      { profileId: input.profileId ?? null },
    );

    res.json({
      status: result.status,
      adapter: result.adapter,
      profile: result.profileName,
      warnings: result.warnings,
      error: result.error ?? null,
      packets: result.packets,
      observedPaths: result.observedPaths.map((path) => ({
        ...path,
        suggestedMetric: suggestMetric(lastSegment(path.path)),
      })),
      note: 'Nothing was stored. This is a dry run against the currently configured profiles.',
    });
  });

  /**
   * Draft a payload profile from what a gateway has actually been sending.
   *
   * The output is a starting point to review and edit, not a verified mapping -
   * it is returned with `verified: false` for exactly that reason.
   */
  router.get('/suggest-profile', async (req, res) => {
    const gatewayUid = stringParam(req, 'gatewayUid');
    if (!gatewayUid) throw badRequest('`gatewayUid` is required.');

    const observations = await listFieldObservations(gatewayUid);
    if (observations.length === 0) {
      throw notFound('No field observations recorded for ' + gatewayUid + ' yet. Wait for a packet to arrive.');
    }

    const definitions = new Set((await listMetricDefinitions()).map((definition) => definition.metricKey));
    const keyMap: Record<string, string> = {};
    const unmatched: string[] = [];
    let timestampPath: string | null = null;
    let gatewayPath: string | null = null;
    let slavePath: string | null = null;
    const measurementContainers = new Set<string>();

    for (const observation of observations) {
      const leaf = lastSegment(observation.jsonPath);
      const container = containerOf(observation.jsonPath);

      if (/^(timestamp|time|ts|datetime|epoch)$/i.test(leaf) && !timestampPath) {
        timestampPath = observation.jsonPath;
        continue;
      }
      if (/^(gateway_?id|device_?id|imei|serial|sn|uid)$/i.test(leaf) && !gatewayPath) {
        gatewayPath = observation.jsonPath;
        continue;
      }
      if (/^(slave_?id|unit_?id|address|addr|station)$/i.test(leaf) && !slavePath) {
        slavePath = observation.jsonPath;
        continue;
      }
      if (observation.valueType !== 'number') continue;

      const suggested = observation.mappedMetric ?? suggestMetric(leaf);
      if (suggested && definitions.has(suggested)) {
        keyMap[leaf] = suggested;
        if (container) measurementContainers.add(container);
      } else {
        unmatched.push(observation.jsonPath);
      }
    }

    res.json({
      gatewayUid,
      draft: {
        name: 'technode_schema_v1',
        vendor: 'technode',
        version: 1,
        enabled: true,
        verified: false,
        priority: 10,
        matchRules: { gatewayUids: [gatewayUid] },
        spec: {
          gatewayIdPaths: gatewayPath ? [gatewayPath] : [],
          slaveIdPaths: slavePath ? [slavePath] : [],
          timestampPaths: timestampPath ? [timestampPath] : [],
          timestampFormat: 'auto',
          assumeUtcOffset: env.DEFAULT_SOURCE_UTC_OFFSET,
          measurementPaths: [...measurementContainers],
          keyMap,
          passthroughUnmapped: false,
        },
      },
      unmatchedPaths: unmatched,
      note:
        'A draft built from observed traffic. Review every mapping against the meter register table, ' +
        'then POST it to /api/admin/payload-profiles and set verified once confirmed.',
    });
  });

  /** Per-gateway detail, including recent parse failures. */
  router.get('/gateways/:gatewayId', async (req, res) => {
    const gateway = await getGateway(pathParam(req, 'gatewayId'));
    if (!gateway) throw notFound('No gateway with id ' + pathParam(req, 'gatewayId'));

    const failures = await listRawMessages({ gatewayUid: gateway.gatewayUid, limit: 200 });
    res.json({
      gateway,
      status: classifyGateway(gateway.lastSeenAt),
      health: await getGatewayHealth(gateway.id),
      meters: await listMeters({ gatewayId: gateway.id }),
      fieldObservations: (await listFieldObservations(gateway.gatewayUid)).map((observation) => ({
        ...observation,
        suggestedMetric: observation.mappedMetric ?? suggestMetric(lastSegment(observation.jsonPath)),
      })),
      parsingErrors: failures.rows
        .filter((message) => message.processingStatus !== 'OK' && message.processingStatus !== 'PENDING')
        .slice(0, 25)
        .map(summariseRaw),
    });
  });

  return router;
}

function summariseRaw(message: RawMessage): Record<string, unknown> {
  return {
    id: message.id,
    gatewayUid: message.gatewayUid,
    transport: message.transport,
    topic: message.mqttTopic,
    receivedAtServer: message.receivedAtServer,
    byteSize: message.byteSize,
    processingStatus: message.processingStatus,
    processingError: message.processingError,
    adapter: message.adapter,
    sampleCount: message.sampleCount,
    // Truncated for list views; GET /raw/:id returns the whole thing.
    payloadPreview: message.payloadText.slice(0, 600),
  };
}

function lastSegment(path: string): string {
  const parts = path.replace(/\[\d+\]/g, '').split('.');
  return parts[parts.length - 1] ?? path;
}

function containerOf(path: string): string | null {
  const cleaned = path.replace(/\[\d+\]/g, '');
  const parts = cleaned.split('.');
  if (parts.length < 2) return null;
  return parts.slice(0, -1).join('.');
}

/**
 * The four things we genuinely cannot know until the hardware is connected.
 * Surfaced in the API so the commissioning screen states them plainly instead
 * of pretending they are settled.
 */
const OPEN_QUESTIONS = [
  {
    key: 'meter_register_table',
    question: "The energy meter's Modbus register table (addresses, datatypes, byte/word order, scaling).",
    resolvedBy: 'The meter manual. Enter it under Admin > meter models > registers.',
    blocks: 'Decoding raw register payloads and trusting decoded values.',
  },
  {
    key: 'technode_payload',
    question: 'One real Technode JSON packet.',
    resolvedBy: 'Commissioning: it appears under /api/commissioning/raw the moment the gateway publishes.',
    blocks: 'Promoting the payload profile from discovery to technode_schema_v1.',
  },
  {
    key: 'mqtt_topic_and_commands',
    question: 'The production MQTT telemetry/configuration topics and the remote-command syntax.',
    resolvedBy: 'Observed topics plus vendor documentation. Narrow MQTT_SUBSCRIBE_TOPICS, fill in command templates.',
    blocks: 'Restricting the subscription and enabling remote configuration.',
  },
  {
    key: 'security_capabilities',
    question: 'Which MQTT authentication and TLS options this unit actually supports.',
    resolvedBy: 'Vendor documentation or bench testing against the broker.',
    blocks: 'Turning on TLS and per-gateway credentials in production.',
  },
];
