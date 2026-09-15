/**
 * Chart palette.
 *
 * The three-phase hues are the categorical set — they carry identity (phase R,
 * Y, B) and appear together on the voltage, current and power-factor charts.
 * They were validated with the dataviz palette checker against a white surface:
 * lightness band PASS, chroma PASS, CVD separation PASS (worst adjacent pair
 * R↔Y, deutan ΔE 10.0), normal-vision floor PASS (ΔE 19.2), with a contrast
 * WARN on the amber (2.86:1). That warning is discharged by always shipping a
 * labelled legend beside these charts and by exposing the same numbers in the
 * Meter Data Logs table.
 *
 * Colour follows the entity, never the rank: phase R is always red whether or
 * not the other two series are toggled on.
 */

export const PHASE = {
  r: '#DC2626',
  y: '#CA8A04',
  b: '#2563EB',
} as const;

/** Single-series measures. Green for energy, blue for current, per the reference. */
export const SERIES = {
  energy: '#12B76A',
  current: '#2563EB',
  power: '#2563EB',
  frequency: '#667085',
} as const;

/** Soft area fills sitting under the line strokes. */
export const FILL = {
  r: 'rgba(220, 38, 38, 0.10)',
  y: 'rgba(202, 138, 4, 0.10)',
  b: 'rgba(37, 99, 235, 0.10)',
} as const;

export const AXIS_COLOR = '#98A2B3';
export const GRID_COLOR = '#EEF0F4';

/** Mark specs shared by every chart, per the dataviz mark guidance. */
export const STROKE_WIDTH = 2;
export const DOT_RADIUS = 2.5;
export const ACTIVE_DOT_RADIUS = 4;
export const BAR_RADIUS: [number, number, number, number] = [4, 4, 0, 0];
