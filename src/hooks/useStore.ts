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

/**
 * Bumps on every store change, including data arriving from the backend.
 *
 * Views that memoise a derived read should depend on this, otherwise they keep
 * showing the empty first render after live data lands.
 */
export function useStoreVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => getState().version,
    () => 0,
  );
}
