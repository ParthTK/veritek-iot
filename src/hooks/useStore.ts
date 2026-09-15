import { useSyncExternalStore } from 'react';
import { getState, subscribe } from '@/services';

/**
 * Re-renders the calling component whenever the demo data store mutates.
 * `selector` should return a stable reference for unchanged data.
 */
export function useStore<T>(selector: (state: ReturnType<typeof getState>) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(getState()),
    () => selector(getState()),
  );
}

/** Bumps whenever anything in the store changes; useful for derived reads. */
export function useStoreVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => getState().devices.length + getState().alerts.length + getState().users.length,
    () => 0,
  );
}
