import express from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { notConfigured, notFound } from '../../core/errors.js';
import { deleteGateway, getGateway, listGateways, rotateGatewayToken, upsertGateway } from '../../db/repositories/gateways.js';
import {
  deleteMeter,
  deleteMeterModel,
  deleteRegisterMapEntry,
  listMeterModels,
  listRegisterMap,
  upsertMeter,
  upsertMeterModel,
  upsertRegisterMapEntry,
} from '../../db/repositories/meters.js';
import { listMetricDefinitions, upsertMetricDefinition } from '../../db/repositories/metrics.js';
import {
  deleteProfile,
  listFieldObservations,
  listProfiles,
  setObservationMapping,
  upsertProfile,
} from '../../db/repositories/profiles.js';
import { listCommandTemplates, listCommands, upsertCommandTemplate } from '../../db/repositories/commands.js';
import { upsertSite, deleteSite } from '../../db/repositories/sites.js';
import { audit, listAuditLog, listUsers, upsertUser, deleteUser } from '../../db/repositories/users.js';
import { queueCommand } from '../../iot/commands/commandService.js';
import { invalidateRegisterMapCache } from '../../iot/modbus/registerMap.js';
import { requireRole } from '../middleware/auth.js';
import { pathParam, stringParam } from '../rangeQuery.js';

/**
 * Configuration APIs.
 *
 * Everything the platform needs in order to speak to a new meter model or a new
 * gateway payload is editable through here - register maps, payload profiles,
 * serial settings, metric definitions. That is the section 5 and 26 requirement
 * in practice: new hardware is data entry, not a deployment.
 */
export function createAdminRouter(): express.Router {
  const router = express.Router();
  router.use(requireRole('Admin'));

  /* ------------------------------------------------------------- sites -- */

  const siteSchema = z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    code: z.string().nullish(),
    city: z.string().nullish(),
    state: z.string().nullish(),
    address: z.string().nullish(),
    timezone: z.string().optional(),
    tariffPerKwh: z.number().nullish(),
    currency: z.string().nullish(),
  });

  router.post('/sites', async (req, res) => {
    const site = await upsertSite(siteSchema.parse(req.body));
    await audit({ actor: req.user?.id ?? null, action: 'site.save', entityType: 'site', entityId: site.id });
    res.status(201).json({ site });
  });

  router.delete('/sites/:siteId', async (req, res) => {
    if (!(await deleteSite(pathParam(req, 'siteId')))) throw notFound('No site with id ' + pathParam(req, 'siteId'));
    await audit({ actor: req.user?.id ?? null, action: 'site.delete', entityType: 'site', entityId: pathParam(req, 'siteId') });
    res.status(204).end();
  });

  /* ---------------------------------------------------------- gateways -- */

  const gatewaySchema = z.object({
    id: z.string().optional(),
    gatewayUid: z.string().min(1),
    name: z.string().optional(),
    siteId: z.string().nullish(),
    imei: z.string().nullish(),
    simNumber: z.string().nullish(),
    iccid: z.string().nullish(),
    mqttClientId: z.string().nullish(),
    mqttUsername: z.string().nullish(),
    hardwareModel: z.string().nullish(),
    firmwareVersion: z.string().nullish(),
    connectionType: z.string().nullish(),
    topicNamespace: z.string().nullish(),
    payloadProfileId: z.string().nullish(),
    sourceUtcOffset: z.string().nullish(),
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    notes: z.string().nullish(),
  });

  router.post('/gateways', async (req, res) => {
    const gateway = await upsertGateway(gatewaySchema.parse(req.body));
    await audit({
      actor: req.user?.id ?? null,
      action: 'gateway.save',
      entityType: 'gateway',
      entityId: gateway.id,
      detail: { gatewayUid: gateway.gatewayUid },
    });
    res.status(201).json({ gateway });
  });

  router.delete('/gateways/:gatewayId', async (req, res) => {
    if (!(await deleteGateway(pathParam(req, 'gatewayId')))) throw notFound('No gateway with id ' + pathParam(req, 'gatewayId'));
    await audit({
      actor: req.user?.id ?? null,
      action: 'gateway.delete',
      entityType: 'gateway',
      entityId: pathParam(req, 'gatewayId'),
    });
    res.status(204).end();
  });

  /**
   * Issue a device credential. The plaintext is returned once and never stored;
   * only its scrypt hash is kept (spec section 18).
   */
  router.post('/gateways/:gatewayId/token', async (req, res) => {
    const gateway = await getGateway(pathParam(req, 'gatewayId'));
    if (!gateway) throw notFound('No gateway with id ' + pathParam(req, 'gatewayId'));

    const token = await rotateGatewayToken(gateway.id);
    await audit({
      actor: req.user?.id ?? null,
      action: 'gateway.token.rotate',
      entityType: 'gateway',
      entityId: gateway.id,
    });
    res.status(201).json({
      gatewayId: gateway.id,
      gatewayUid: gateway.gatewayUid,
      token,
      note:
        env.MQTT_BROKER_AUTH === 'dynsec'
          ? 'Store this now - it cannot be retrieved again. This is the HTTP ingest bearer token. ' +
            'MQTT credentials are separate: issue them with POST /api/provisioning/gateways/:id/rotate.'
          : 'Store this now - it cannot be retrieved again. Use it as the MQTT password ' +
            '(username = gateway uid) or as the HTTP ingest bearer token.',
    });
  });

  /* ------------------------------------------------------------ meters -- */

  const meterSchema = z.object({
    id: z.string().optional(),
    meterUid: z.string().min(1),
    siteId: z.string().nullish(),
    gatewayId: z.string().nullish(),
    meterModelId: z.string().nullish(),
    meterName: z.string().optional(),
    location: z.string().nullish(),
    slaveId: z.number().int().nullish(),
    baudRate: z.number().int().nullish(),
    parity: z.enum(['none', 'even', 'odd']).nullish(),
    stopBits: z.number().int().nullish(),
    dataBits: z.number().int().nullish(),
    pollIntervalSeconds: z.number().int().nullish(),
    enabled: z.boolean().optional(),
    installedAt: z.string().nullish(),
    config: z.record(z.string(), z.unknown()).optional(),
    notes: z.string().nullish(),
  });

  router.post('/meters', async (req, res) => {
    const meter = await upsertMeter(meterSchema.parse(req.body));
    await audit({
      actor: req.user?.id ?? null,
      action: 'meter.save',
      entityType: 'meter',
      entityId: meter.id,
      detail: { meterUid: meter.meterUid, slaveId: meter.slaveId },
    });
    res.status(201).json({ meter });
  });

  router.delete('/meters/:meterId', async (req, res) => {
    if (!(await deleteMeter(pathParam(req, 'meterId')))) throw notFound('No meter with id ' + pathParam(req, 'meterId'));
    await audit({
      actor: req.user?.id ?? null,
      action: 'meter.delete',
      entityType: 'meter',
      entityId: pathParam(req, 'meterId'),
    });
    res.status(204).end();
  });

  /* ------------------------------------------------------ meter models -- */

  const modelSchema = z.object({
    id: z.string().optional(),
    manufacturer: z.string().min(1),
    model: z.string().min(1),
    protocol: z.string().optional(),
    defaultBaudRate: z.number().int().nullish(),
    defaultParity: z.enum(['none', 'even', 'odd']).nullish(),
    defaultStopBits: z.number().int().nullish(),
    defaultDataBits: z.number().int().nullish(),
    defaultSlaveId: z.number().int().nullish(),
    defaultPollIntervalSeconds: z.number().int().nullish(),
    verified: z.boolean().optional(),
    notes: z.string().nullish(),
  });

  router.get('/meter-models', async (_req, res) => {
    const models = await listMeterModels();
    const withCounts = await Promise.all(
      models.map(async (model) => ({
        ...model,
        registerCount: (await listRegisterMap(model.id)).length,
      })),
    );
    res.json({ models: withCounts });
  });

  router.post('/meter-models', async (req, res) => {
    const model = await upsertMeterModel(modelSchema.parse(req.body));
    await audit({
      actor: req.user?.id ?? null,
      action: 'meterModel.save',
      entityType: 'meter_model',
      entityId: model.id,
    });
    res.status(201).json({ model });
  });

  router.delete('/meter-models/:modelId', async (req, res) => {
    if (!(await deleteMeterModel(pathParam(req, 'modelId')))) throw notFound('No meter model with id ' + pathParam(req, 'modelId'));
    invalidateRegisterMapCache(pathParam(req, 'modelId'));
    res.status(204).end();
  });

  /* ----------------------------------------------------- register maps -- */

  const registerSchema = z.object({
    id: z.string().optional(),
    meterModelId: z.string().min(1),
    metricKey: z.string().min(1),
    displayName: z.string().nullish(),
    slaveId: z.number().int().nullish(),
    functionCode: z.number().int().min(1).max(4).optional(),
    registerType: z.enum(['HOLDING', 'INPUT', 'COIL', 'DISCRETE']).optional(),
    registerAddress: z.number().int().min(0),
    registerLength: z.number().int().min(1).max(8).optional(),
    datatype: z.enum([
      'INT16', 'UINT16', 'INT32', 'UINT32', 'INT64', 'UINT64',
      'FLOAT32', 'FLOAT64', 'BOOL', 'BITFIELD', 'STRING',
    ]),
    byteOrder: z.enum(['big', 'little']).optional(),
    wordOrder: z.enum(['big', 'little']).optional(),
    bitMask: z.number().int().nullish(),
    bitOffset: z.number().int().nullish(),
    scale: z.number().optional(),
    valueOffset: z.number().optional(),
    unit: z.string().nullish(),
    writable: z.boolean().optional(),
    enabled: z.boolean().optional(),
    sourceKey: z.string().nullish(),
    pollIntervalSeconds: z.number().int().nullish(),
    notes: z.string().nullish(),
  });

  router.get('/meter-models/:modelId/registers', async (req, res) => {
    res.json({ meterModelId: pathParam(req, 'modelId'), entries: await listRegisterMap(pathParam(req, 'modelId')) });
  });

  router.post('/registers', async (req, res) => {
    const entry = await upsertRegisterMapEntry(registerSchema.parse(req.body));
    invalidateRegisterMapCache(entry.meterModelId);
    await audit({
      actor: req.user?.id ?? null,
      action: 'register.save',
      entityType: 'register_map',
      entityId: entry.id,
      detail: { metricKey: entry.metricKey, address: entry.registerAddress, datatype: entry.datatype },
    });
    res.status(201).json({ entry });
  });

  /** Bulk import: the natural shape for typing in a meter's register table. */
  router.post('/registers/bulk', async (req, res) => {
    const entries = z.array(registerSchema).parse(req.body?.entries ?? req.body);
    const saved = [];
    for (const entry of entries) saved.push(await upsertRegisterMapEntry(entry));
    invalidateRegisterMapCache();
    await audit({
      actor: req.user?.id ?? null,
      action: 'register.bulkImport',
      entityType: 'register_map',
      entityId: null,
      detail: { count: saved.length },
    });
    res.status(201).json({ entries: saved });
  });

  router.delete('/registers/:registerId', async (req, res) => {
    if (!(await deleteRegisterMapEntry(pathParam(req, 'registerId')))) {
      throw notFound('No register map entry with id ' + pathParam(req, 'registerId'));
    }
    invalidateRegisterMapCache();
    res.status(204).end();
  });

  /* --------------------------------------------------- payload profiles -- */

  const profileSchema = z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    vendor: z.string().min(1),
    version: z.number().int().optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().optional(),
    verified: z.boolean().optional(),
    matchRules: z.record(z.string(), z.unknown()).optional(),
    spec: z.record(z.string(), z.unknown()).optional(),
    notes: z.string().nullish(),
  });

  router.get('/payload-profiles', async (_req, res) => {
    res.json({ profiles: await listProfiles(true) });
  });

  router.post('/payload-profiles', async (req, res) => {
    const parsed = profileSchema.parse(req.body);
    const profile = await upsertProfile({
      ...parsed,
      matchRules: parsed.matchRules as never,
      spec: parsed.spec as never,
    });
    await audit({
      actor: req.user?.id ?? null,
      action: 'payloadProfile.save',
      entityType: 'payload_profile',
      entityId: profile.id,
      detail: { name: profile.name, verified: profile.verified },
    });
    res.status(201).json({ profile });
  });

  router.delete('/payload-profiles/:profileId', async (req, res) => {
    if (!(await deleteProfile(pathParam(req, 'profileId')))) {
      throw notFound('No payload profile with id ' + pathParam(req, 'profileId'));
    }
    res.status(204).end();
  });

  /* ------------------------------------------------ field observations -- */

  router.get('/field-observations', async (req, res) => {
    res.json({ observations: await listFieldObservations(stringParam(req, 'gatewayUid')) });
  });

  router.post('/field-observations/:id/map', async (req, res) => {
    const metricKey = z.object({ metricKey: z.string().nullable() }).parse(req.body).metricKey;
    await setObservationMapping(pathParam(req, 'id'), metricKey);
    res.json({ ok: true });
  });

  /* ------------------------------------------------ metric definitions -- */

  const metricSchema = z.object({
    metricKey: z.string().min(1),
    displayName: z.string().min(1),
    unit: z.string().nullish(),
    category: z.string().nullish(),
    kind: z.enum(['instant', 'cumulative', 'demand', 'status']).optional(),
    aggregation: z.enum(['avg', 'sum', 'last', 'max', 'min', 'delta']).optional(),
    decimals: z.number().int().min(0).max(8).optional(),
    minValid: z.number().nullish(),
    maxValid: z.number().nullish(),
    sortOrder: z.number().int().optional(),
  });

  router.get('/metrics', async (_req, res) => {
    res.json({ metrics: await listMetricDefinitions() });
  });

  router.post('/metrics', async (req, res) => {
    await upsertMetricDefinition(metricSchema.parse(req.body));
    res.status(201).json({ metrics: await listMetricDefinitions() });
  });

  /* ---------------------------------------------------------- commands -- */

  router.get('/command-templates', async (req, res) => {
    res.json({
      templates: await listCommandTemplates(stringParam(req, 'hardwareModel')),
      commandsEnabled: env.COMMANDS_ENABLED,
      note:
        'Remote configuration stays disarmed until a template is filled in from real vendor ' +
        "documentation and marked verified. the vendor's command syntax is not published.",
    });
  });

  router.post('/command-templates', async (req, res) => {
    const schema = z.object({
      id: z.string().optional(),
      hardwareModel: z.string().min(1),
      commandType: z.string().min(1),
      description: z.string().nullish(),
      topicTemplate: z.string().nullish(),
      payloadTemplate: z.record(z.string(), z.unknown()).optional(),
      ackMatch: z.record(z.string(), z.unknown()).optional(),
      enabled: z.boolean().optional(),
      verified: z.boolean().optional(),
      notes: z.string().nullish(),
    });
    const template = await upsertCommandTemplate(schema.parse(req.body));
    await audit({
      actor: req.user?.id ?? null,
      action: 'commandTemplate.save',
      entityType: 'command_template',
      entityId: template.id,
      detail: { commandType: template.commandType, verified: template.verified },
    });
    res.status(201).json({ template });
  });

  router.get('/commands', async (req, res) => {
    res.json({ commands: await listCommands({ gatewayId: stringParam(req, 'gatewayId'), limit: 100 }) });
  });

  router.post('/commands', async (req, res) => {
    const schema = z.object({
      gatewayId: z.string().min(1),
      commandType: z.string().min(1),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      force: z.boolean().optional(),
    });
    const input = schema.parse(req.body);
    const result = await queueCommand({ ...input, requestedBy: req.user?.id ?? null });

    if (result.outcome === 'BLOCKED') {
      // 501: the capability exists, the vendor's wire format does not yet.
      throw notConfigured(result.reason ?? 'Command could not be transmitted.', {
        command: result.command,
      });
    }
    res.status(202).json(result);
  });

  /* --------------------------------------------------------------- users -- */

  router.get('/users', async (_req, res) => {
    res.json({ users: await listUsers() });
  });

  router.post('/users', async (req, res) => {
    const schema = z.object({
      id: z.string().optional(),
      name: z.string().min(1),
      email: z.string().email(),
      phone: z.string().nullish(),
      role: z.enum(['Super Admin', 'Admin', 'Operator', 'Viewer']).optional(),
      password: z.string().min(8).optional(),
      active: z.boolean().optional(),
      assignedSites: z.array(z.string()).optional(),
    });
    const user = await upsertUser(schema.parse(req.body));
    await audit({ actor: req.user?.id ?? null, action: 'user.save', entityType: 'user', entityId: user.id });
    res.status(201).json({ user });
  });

  router.delete('/users/:userId', async (req, res) => {
    if (!(await deleteUser(pathParam(req, 'userId')))) throw notFound('No user with id ' + pathParam(req, 'userId'));
    await audit({ actor: req.user?.id ?? null, action: 'user.delete', entityType: 'user', entityId: pathParam(req, 'userId') });
    res.status(204).end();
  });

  router.get('/audit-log', async (_req, res) => {
    res.json({ entries: await listAuditLog(300) });
  });

  router.get('/gateways', async (_req, res) => {
    res.json({ gateways: await listGateways() });
  });

  return router;
}
