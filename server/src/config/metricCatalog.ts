import type { MetricDefinitionInput } from '../db/repositories/metrics.js';

/**
 * The platform's metric catalogue (spec section 11).
 *
 * This is *our* vocabulary. It says nothing about which registers a particular
 * meter exposes - that is the register map's job, and whether a given meter
 * reports THD or export energy depends entirely on the meter. A metric being
 * listed here only means the platform knows how to store, aggregate and display
 * it if some meter does report it.
 *
 * `kind: 'cumulative'` is the important flag: those are running totals that get
 * differenced, never summed (section 13).
 *
 * `minValid` / `maxValid` are plausibility bounds for quality flagging only.
 * A reading outside them is stored and marked SUSPECT, never discarded.
 */
export const METRIC_CATALOG: MetricDefinitionInput[] = [
  /* ------------------------------------------------- phase voltages (L-N) -- */
  { metricKey: 'voltage_l1', displayName: 'Voltage L1-N', unit: 'V', category: 'voltage', kind: 'instant', aggregation: 'avg', decimals: 1, minValid: 0, maxValid: 1000, sortOrder: 10 },
  { metricKey: 'voltage_l2', displayName: 'Voltage L2-N', unit: 'V', category: 'voltage', kind: 'instant', aggregation: 'avg', decimals: 1, minValid: 0, maxValid: 1000, sortOrder: 11 },
  { metricKey: 'voltage_l3', displayName: 'Voltage L3-N', unit: 'V', category: 'voltage', kind: 'instant', aggregation: 'avg', decimals: 1, minValid: 0, maxValid: 1000, sortOrder: 12 },
  { metricKey: 'voltage_avg', displayName: 'Average Voltage', unit: 'V', category: 'voltage', kind: 'instant', aggregation: 'avg', decimals: 1, minValid: 0, maxValid: 1000, sortOrder: 13 },

  /* ------------------------------------------------- line voltages (L-L) -- */
  { metricKey: 'voltage_l12', displayName: 'Voltage L1-L2', unit: 'V', category: 'voltage', kind: 'instant', aggregation: 'avg', decimals: 1, minValid: 0, maxValid: 1500, sortOrder: 20 },
  { metricKey: 'voltage_l23', displayName: 'Voltage L2-L3', unit: 'V', category: 'voltage', kind: 'instant', aggregation: 'avg', decimals: 1, minValid: 0, maxValid: 1500, sortOrder: 21 },
  { metricKey: 'voltage_l31', displayName: 'Voltage L3-L1', unit: 'V', category: 'voltage', kind: 'instant', aggregation: 'avg', decimals: 1, minValid: 0, maxValid: 1500, sortOrder: 22 },

  /* ---------------------------------------------------------- currents -- */
  { metricKey: 'current_l1', displayName: 'Current L1', unit: 'A', category: 'current', kind: 'instant', aggregation: 'avg', decimals: 2, minValid: 0, maxValid: 10000, sortOrder: 30 },
  { metricKey: 'current_l2', displayName: 'Current L2', unit: 'A', category: 'current', kind: 'instant', aggregation: 'avg', decimals: 2, minValid: 0, maxValid: 10000, sortOrder: 31 },
  { metricKey: 'current_l3', displayName: 'Current L3', unit: 'A', category: 'current', kind: 'instant', aggregation: 'avg', decimals: 2, minValid: 0, maxValid: 10000, sortOrder: 32 },
  { metricKey: 'current_neutral', displayName: 'Neutral Current', unit: 'A', category: 'current', kind: 'instant', aggregation: 'avg', decimals: 2, minValid: 0, maxValid: 10000, sortOrder: 33 },
  { metricKey: 'current_avg', displayName: 'Average Current', unit: 'A', category: 'current', kind: 'instant', aggregation: 'avg', decimals: 2, minValid: 0, maxValid: 10000, sortOrder: 34 },

  /* ------------------------------------------------------------- power -- */
  { metricKey: 'active_power_kw', displayName: 'Active Power', unit: 'kW', category: 'power', kind: 'instant', aggregation: 'avg', decimals: 3, minValid: -100000, maxValid: 100000, sortOrder: 40 },
  { metricKey: 'reactive_power_kvar', displayName: 'Reactive Power', unit: 'kVAr', category: 'power', kind: 'instant', aggregation: 'avg', decimals: 3, minValid: -100000, maxValid: 100000, sortOrder: 41 },
  { metricKey: 'apparent_power_kva', displayName: 'Apparent Power', unit: 'kVA', category: 'power', kind: 'instant', aggregation: 'avg', decimals: 3, minValid: 0, maxValid: 100000, sortOrder: 42 },
  { metricKey: 'active_power_l1_kw', displayName: 'Active Power L1', unit: 'kW', category: 'power', kind: 'instant', aggregation: 'avg', decimals: 3, minValid: -50000, maxValid: 50000, sortOrder: 43 },
  { metricKey: 'active_power_l2_kw', displayName: 'Active Power L2', unit: 'kW', category: 'power', kind: 'instant', aggregation: 'avg', decimals: 3, minValid: -50000, maxValid: 50000, sortOrder: 44 },
  { metricKey: 'active_power_l3_kw', displayName: 'Active Power L3', unit: 'kW', category: 'power', kind: 'instant', aggregation: 'avg', decimals: 3, minValid: -50000, maxValid: 50000, sortOrder: 45 },

  /* ------------------------------------------------- power factor / freq -- */
  { metricKey: 'power_factor', displayName: 'Power Factor', unit: null, category: 'quality', kind: 'instant', aggregation: 'avg', decimals: 3, minValid: -1, maxValid: 1, sortOrder: 50 },
  { metricKey: 'power_factor_l1', displayName: 'Power Factor L1', unit: null, category: 'quality', kind: 'instant', aggregation: 'avg', decimals: 3, minValid: -1, maxValid: 1, sortOrder: 51 },
  { metricKey: 'power_factor_l2', displayName: 'Power Factor L2', unit: null, category: 'quality', kind: 'instant', aggregation: 'avg', decimals: 3, minValid: -1, maxValid: 1, sortOrder: 52 },
  { metricKey: 'power_factor_l3', displayName: 'Power Factor L3', unit: null, category: 'quality', kind: 'instant', aggregation: 'avg', decimals: 3, minValid: -1, maxValid: 1, sortOrder: 53 },
  { metricKey: 'frequency_hz', displayName: 'Frequency', unit: 'Hz', category: 'quality', kind: 'instant', aggregation: 'avg', decimals: 2, minValid: 40, maxValid: 70, sortOrder: 54 },

  /* ---------------------------------------------- cumulative energy -- */
  // Running totals. Consumption is end - start; never a sum of these values.
  { metricKey: 'energy_import_kwh', displayName: 'Import Active Energy', unit: 'kWh', category: 'energy', kind: 'cumulative', aggregation: 'last', decimals: 3, minValid: 0, maxValid: null, sortOrder: 60 },
  { metricKey: 'energy_export_kwh', displayName: 'Export Active Energy', unit: 'kWh', category: 'energy', kind: 'cumulative', aggregation: 'last', decimals: 3, minValid: 0, maxValid: null, sortOrder: 61 },
  { metricKey: 'reactive_energy_kvarh', displayName: 'Reactive Energy', unit: 'kVArh', category: 'energy', kind: 'cumulative', aggregation: 'last', decimals: 3, minValid: 0, maxValid: null, sortOrder: 62 },
  { metricKey: 'apparent_energy_kvah', displayName: 'Apparent Energy', unit: 'kVAh', category: 'energy', kind: 'cumulative', aggregation: 'last', decimals: 3, minValid: 0, maxValid: null, sortOrder: 63 },
  { metricKey: 'energy_export_kvarh', displayName: 'Export Reactive Energy', unit: 'kVArh', category: 'energy', kind: 'cumulative', aggregation: 'last', decimals: 3, minValid: 0, maxValid: null, sortOrder: 64 },

  /* ------------------------------------------------------------ demand -- */
  { metricKey: 'demand_kw', displayName: 'Present Demand', unit: 'kW', category: 'demand', kind: 'demand', aggregation: 'avg', decimals: 3, minValid: 0, maxValid: 100000, sortOrder: 70 },
  { metricKey: 'max_demand_kw', displayName: 'Maximum Demand', unit: 'kW', category: 'demand', kind: 'demand', aggregation: 'max', decimals: 3, minValid: 0, maxValid: 100000, sortOrder: 71 },
  { metricKey: 'demand_kva', displayName: 'Present Demand (kVA)', unit: 'kVA', category: 'demand', kind: 'demand', aggregation: 'avg', decimals: 3, minValid: 0, maxValid: 100000, sortOrder: 72 },
  { metricKey: 'max_demand_kva', displayName: 'Maximum Demand (kVA)', unit: 'kVA', category: 'demand', kind: 'demand', aggregation: 'max', decimals: 3, minValid: 0, maxValid: 100000, sortOrder: 73 },

  /* -------------------------------------------------------- harmonics -- */
  { metricKey: 'thd_voltage_pct', displayName: 'Voltage THD', unit: '%', category: 'harmonics', kind: 'instant', aggregation: 'avg', decimals: 2, minValid: 0, maxValid: 100, sortOrder: 80 },
  { metricKey: 'thd_current_pct', displayName: 'Current THD', unit: '%', category: 'harmonics', kind: 'instant', aggregation: 'avg', decimals: 2, minValid: 0, maxValid: 100, sortOrder: 81 },
  { metricKey: 'thd_voltage_l1_pct', displayName: 'Voltage THD L1', unit: '%', category: 'harmonics', kind: 'instant', aggregation: 'avg', decimals: 2, minValid: 0, maxValid: 100, sortOrder: 82 },
  { metricKey: 'thd_current_l1_pct', displayName: 'Current THD L1', unit: '%', category: 'harmonics', kind: 'instant', aggregation: 'avg', decimals: 2, minValid: 0, maxValid: 100, sortOrder: 83 },

  /* ---------------------------------------------------------- analogue -- */
  // The unit also carries a single-channel 12-bit 4-20 mA input. Whatever it is
  // wired to (a transducer, a tank level, a temperature loop) lands here and is
  // scaled by the register map, which is why the metric is deliberately generic.
  { metricKey: 'analog_input_ma', displayName: 'Analogue Input (4-20 mA)', unit: 'mA', category: 'analog', kind: 'instant', aggregation: 'avg', decimals: 3, minValid: 0, maxValid: 25, sortOrder: 90 },
  { metricKey: 'analog_input_scaled', displayName: 'Analogue Input (scaled)', unit: null, category: 'analog', kind: 'instant', aggregation: 'avg', decimals: 3, minValid: null, maxValid: null, sortOrder: 91 },

  /* ------------------------------------------------------ device health -- */
  { metricKey: 'signal_strength_dbm', displayName: 'Cellular Signal', unit: 'dBm', category: 'device', kind: 'instant', aggregation: 'avg', decimals: 0, minValid: -140, maxValid: 0, sortOrder: 100 },
  { metricKey: 'device_temperature_c', displayName: 'Device Temperature', unit: 'degC', category: 'device', kind: 'instant', aggregation: 'avg', decimals: 1, minValid: -40, maxValid: 120, sortOrder: 101 },
];
