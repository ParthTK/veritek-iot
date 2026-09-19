import { listProfiles } from '../../db/repositories/profiles.js';
import { VeritekPayloadAdapter } from './veritek/parser.js';
import type { AdapterResult, PayloadContext } from './types.js';

/**
 * Adapter registry.
 *
 * Adding a second gateway vendor means registering another adapter here; the
 * storage schema, rollups, energy maths, alerts and APIs stay untouched, which
 * is the vendor-independence requirement in spec section 22.
 */

export type AdapterFactory = (profiles: Awaited<ReturnType<typeof listProfiles>>) => {
  name: string;
  canHandle(payload: unknown, context: PayloadContext): boolean;
  parse(payload: unknown, context: PayloadContext): AdapterResult;
};

const factories = new Map<string, AdapterFactory>();

export function registerAdapter(vendor: string, factory: AdapterFactory): void {
  factories.set(vendor, factory);
}

registerAdapter('veritek', (profiles) => new VeritekPayloadAdapter(profiles));

/**
 * Parse a payload with the adapter that owns it.
 *
 * Selection is by the vendor on the matching payload profile; with no match we
 * fall back to the Veritek adapter's discovery pass, which is what keeps an
 * unrecognised first packet from killing the MQTT consumer.
 */
export async function parsePayload(
  payload: unknown,
  context: PayloadContext,
  options: { vendorHint?: string | null; profileId?: string | null } = {},
): Promise<AdapterResult> {
  const allProfiles = await listProfiles();

  const scoped = options.profileId
    ? allProfiles.filter((profile) => profile.id === options.profileId)
    : allProfiles;

  const vendor =
    options.vendorHint ??
    scoped.find((profile) => profile.enabled)?.vendor ??
    'veritek';

  const factory = factories.get(vendor) ?? factories.get('veritek');
  if (!factory) {
    return {
      status: 'INVALID_PAYLOAD',
      adapter: 'none',
      profileId: null,
      profileName: null,
      packets: [],
      warnings: [],
      error: 'No adapter registered for vendor ' + vendor + '.',
      observedPaths: [],
    };
  }

  const adapter = factory(scoped);
  if (!adapter.canHandle(payload, context)) {
    return {
      status: 'INVALID_PAYLOAD',
      adapter: adapter.name,
      profileId: null,
      profileName: null,
      packets: [],
      warnings: [],
      error: 'Adapter ' + adapter.name + ' cannot handle this payload shape.',
      observedPaths: [],
    };
  }

  return adapter.parse(payload, context);
}

export function listAdapterNames(): string[] {
  return [...factories.keys()];
}
