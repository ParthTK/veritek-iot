import { createContext, useContext } from 'react';

interface DeviceContextValue {
  /** The device the "Data & Logs" section is scoped to, or null. */
  deviceId: string | null;
  selectDevice: (id: string | null) => void;
}

export const DeviceContext = createContext<DeviceContextValue>({
  deviceId: null,
  selectDevice: () => {},
});

export function useDeviceSelection(): DeviceContextValue {
  return useContext(DeviceContext);
}
