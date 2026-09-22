/**
 * Where the dashboard's data comes from.
 *
 *   demo  - only the bundled fixtures, regenerated in the browser. No backend.
 *   live  - only what the server reports. An estate with no devices shows empty.
 *   mixed - both: real devices from the server listed alongside the demo ones,
 *           each reading its own history from its own source.
 *
 * `mixed` is the default because both are true at once right now - there is a
 * real broker taking real devices, and a demo dataset people are shown. A
 * device is never half-real: its readings come from the same place its record
 * did, so nothing on screen is part live and part invented.
 */
export type DataMode = 'demo' | 'live' | 'mixed';

function resolve(): DataMode {
  const explicit = import.meta.env.VITE_DATA_MODE as string | undefined;
  if (explicit === 'demo' || explicit === 'live' || explicit === 'mixed') return explicit;
  // The older switch, kept working.
  if (import.meta.env.VITE_LIVE_DATA === 'true') return 'live';
  return 'mixed';
}

export const DATA_MODE: DataMode = resolve();

/** True when the dashboard should talk to the backend at all. */
export const USES_BACKEND = DATA_MODE !== 'demo';

/** True when the bundled fixtures should be shown. */
export const SHOWS_DEMO = DATA_MODE !== 'live';
