/** Presentation helpers. Units follow the reference capture exactly. */

export const UNITS = {
  voltage: 'V',
  current: 'A',
  power: 'kW',
  energy: 'kWh',
  apparentEnergy: 'kVAh',
  reactiveEnergy: 'kVArh',
  frequency: 'Hz',
  powerFactor: '',
} as const;

export function formatNumber(value: number, decimals = 2): string {
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatValue(value: number, unit: string, decimals = 2): string {
  return unit ? `${formatNumber(value, decimals)} ${unit}` : formatNumber(value, decimals);
}

export function formatCurrency(value: number): string {
  return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "11/22/2025, 11:32 AM" — the format shown on the meter cards. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US')}, ${d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })}`;
}

/** "Nov 22, 10:04 AM" — the chart axis format. */
export function formatAxisTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString(
    'en-US',
    { hour: 'numeric', minute: '2-digit', hour12: true },
  )}`;
}

/** "10:21:32 AM" — the "Last updated" indicator. */
export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

export function formatDateOnly(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US');
}

/** "2 minutes ago" style helper for last-seen indicators. */
export function formatRelative(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function toInputDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}
