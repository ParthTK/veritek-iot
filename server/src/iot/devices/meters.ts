import { env } from '../../config/env.js';
import { LogEvent } from '../../core/logEvents.js';
import { createLogger } from '../../core/logger.js';
import { nowIso } from '../../core/time.js';
import type { Gateway } from '../../db/repositories/gateways.js';
import type { Meter } from '../../db/repositories/meters.js';
import {
  getMeterByGatewaySlave,
  getMeterByUid,
  getSoleMeterForGateway,
  upsertMeter,
} from '../../db/repositories/meters.js';

const log = createLogger('devices:meters');

/**
 * Meter identity resolution.
 *
 * One gateway, many meters: the Technode unit polls several Modbus slaves on
 * the same RS485 pair, so `gateway + slave_id` - not the gateway alone - is the
 * key that identifies a meter (spec section 7).
 */

export interface MeterResolution {
  meter: Meter | null;
  provisioned: boolean;
  reason: string | null;
}

export async function resolveMeter(
  gateway: Gateway,
  slaveId: number | null,
  meterUid: string | null,
): Promise<MeterResolution> {
  if (meterUid) {
    const byUid = await getMeterByUid(meterUid);
    if (byUid) return { meter: byUid, provisioned: false, reason: null };
  }

  if (slaveId !== null) {
    const bySlave = await getMeterByGatewaySlave(gateway.id, slaveId);
    if (bySlave) return { meter: bySlave, provisioned: false, reason: null };
  }

  // A payload with no slave id is still usable when the gateway has exactly one
  // meter - which is the common single-meter installation.
  if (slaveId === null && !meterUid) {
    const sole = await getSoleMeterForGateway(gateway.id);
    if (sole) return { meter: sole, provisioned: false, reason: 'gateway has a single meter' };
  }

  if (!env.AUTO_PROVISION_METERS) {
    log.warn('no meter matches this packet and auto-provisioning is off', {
      event: LogEvent.UNKNOWN_SLAVE,
      gatewayUid: gateway.gatewayUid,
      slaveId,
      meterUid,
    });
    return { meter: null, provisioned: false, reason: 'auto-provisioning disabled' };
  }

  const uid = meterUid ?? gateway.gatewayUid + ':' + (slaveId ?? 'default');
  const meter = await upsertMeter({
    meterUid: uid,
    gatewayId: gateway.id,
    siteId: gateway.siteId,
    meterName: slaveId === null ? gateway.name + ' meter' : gateway.name + ' slave ' + slaveId,
    slaveId,
    installedAt: nowIso(),
    notes:
      'Auto-provisioned on first reading. Set its meter model, serial line settings ' +
      '(baud/parity/stop bits) and register map before trusting decoded values.',
  });

  log.info('auto-provisioned a meter for an unseen Modbus slave', {
    event: LogEvent.UNKNOWN_SLAVE,
    gatewayUid: gateway.gatewayUid,
    meterId: meter.id,
    slaveId,
  });
  return { meter, provisioned: true, reason: null };
}
