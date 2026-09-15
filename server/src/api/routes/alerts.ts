import express from 'express';
import { z } from 'zod';
import { notFound } from '../../core/errors.js';
import type { AlertSeverity, AlertStatus } from '../../db/repositories/alerts.js';
import {
  deleteAlertRule,
  listAlertRules,
  listAlerts,
  setAlertStatus,
  upsertAlertRule,
} from '../../db/repositories/alerts.js';
import { audit } from '../../db/repositories/users.js';
import { requireRole } from '../middleware/auth.js';
import { intParam, parseRange, pathParam, stringParam } from '../rangeQuery.js';

const ruleSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  scope: z.enum(['global', 'site', 'gateway', 'meter']).optional(),
  siteId: z.string().nullish(),
  gatewayId: z.string().nullish(),
  meterId: z.string().nullish(),
  metric: z.string().nullish(),
  condition: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'outside', 'inside', 'no_data', 'device_offline']),
  threshold: z.number().nullish(),
  thresholdHigh: z.number().nullish(),
  durationSeconds: z.number().int().min(0).optional(),
  severity: z.enum(['critical', 'warning', 'info']).optional(),
  enabled: z.boolean().optional(),
  cooldownSeconds: z.number().int().min(0).optional(),
  notify: z.record(z.string(), z.unknown()).optional(),
  messageTemplate: z.string().nullish(),
});

export function createAlertsRouter(): express.Router {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const hasRange = Boolean(stringParam(req, 'from') ?? stringParam(req, 'to'));
    const range = hasRange ? parseRange(req, 30 * 86_400_000) : null;

    const result = await listAlerts({
      status: stringParam(req, 'status') as AlertStatus | undefined,
      severity: stringParam(req, 'severity') as AlertSeverity | undefined,
      siteId: stringParam(req, 'siteId'),
      meterId: stringParam(req, 'meterId'),
      gatewayId: stringParam(req, 'gatewayId'),
      from: range?.from,
      to: range?.to,
      limit: intParam(req, 'limit', 100),
      offset: intParam(req, 'offset', 0),
    });
    res.json(result);
  });

  router.post('/:alertId/acknowledge', requireRole('Operator'), async (req, res) => {
    const alert = await setAlertStatus(pathParam(req, 'alertId'), 'acknowledged', req.user?.id ?? null);
    if (!alert) throw notFound('No alert with id ' + pathParam(req, 'alertId'));
    await audit({
      actor: req.user?.id ?? null,
      action: 'alert.acknowledge',
      entityType: 'alert',
      entityId: alert.id,
    });
    res.json({ alert });
  });

  router.post('/:alertId/resolve', requireRole('Operator'), async (req, res) => {
    const alert = await setAlertStatus(pathParam(req, 'alertId'), 'resolved', req.user?.id ?? null);
    if (!alert) throw notFound('No alert with id ' + pathParam(req, 'alertId'));
    await audit({
      actor: req.user?.id ?? null,
      action: 'alert.resolve',
      entityType: 'alert',
      entityId: alert.id,
    });
    res.json({ alert });
  });

  /* ----------------------------------------------------------------- rules -- */

  router.get('/rules', async (_req, res) => {
    res.json({ rules: await listAlertRules(true) });
  });

  router.post('/rules', requireRole('Admin'), async (req, res) => {
    const input = ruleSchema.parse(req.body);
    const rule = await upsertAlertRule(input);
    await audit({
      actor: req.user?.id ?? null,
      action: 'alert.rule.save',
      entityType: 'alert_rule',
      entityId: rule.id,
      detail: { name: rule.name, condition: rule.condition, threshold: rule.threshold },
    });
    res.status(201).json({ rule });
  });

  router.delete('/rules/:ruleId', requireRole('Admin'), async (req, res) => {
    const removed = await deleteAlertRule(pathParam(req, 'ruleId'));
    if (!removed) throw notFound('No alert rule with id ' + pathParam(req, 'ruleId'));
    await audit({
      actor: req.user?.id ?? null,
      action: 'alert.rule.delete',
      entityType: 'alert_rule',
      entityId: pathParam(req, 'ruleId'),
    });
    res.status(204).end();
  });

  return router;
}
