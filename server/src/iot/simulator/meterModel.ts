/**
 * A synthetic three-phase energy meter.
 *
 * Purpose: exercise the pipeline with data that behaves like a real meter -
 * a daily load curve, correlated voltage sag under load, a power factor that
 * moves with loading, and above all a *monotonic* kWh counter, so the energy
 * arithmetic in section 13 is genuinely tested rather than assumed.
 */

export interface SimulatedReading {
  voltage_l1: number;
  voltage_l2: number;
  voltage_l3: number;
  voltage_l12: number;
  voltage_l23: number;
  voltage_l31: number;
  current_l1: number;
  current_l2: number;
  current_l3: number;
  active_power_kw: number;
  reactive_power_kvar: number;
  apparent_power_kva: number;
  power_factor: number;
  frequency_hz: number;
  energy_import_kwh: number;
  energy_export_kwh: number;
  reactive_energy_kvarh: number;
  demand_kw: number;
}

export interface SimulatorMeterOptions {
  slaveId: number;
  /** Nameplate load in kW at full daytime demand. */
  peakKw?: number;
  nominalVoltage?: number;
  /** Starting cumulative import register. */
  startKwh?: number;
  /** Deterministic series per meter. */
  seed?: number;
  timezone?: string;
}

/** Small, fast, deterministic PRNG (mulberry32). */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fraction of peak load at a given local hour - a factory-shaped day. */
function loadProfile(hourOfDay: number): number {
  const shape = [
    0.28, 0.25, 0.24, 0.24, 0.26, 0.34, 0.52, 0.71,
    0.86, 0.94, 0.97, 0.99, 0.92, 0.95, 0.98, 0.96,
    0.90, 0.82, 0.74, 0.66, 0.56, 0.45, 0.36, 0.31,
  ];
  const index = Math.floor(hourOfDay) % 24;
  const next = (index + 1) % 24;
  const fraction = hourOfDay - Math.floor(hourOfDay);
  // Interpolated so consecutive samples move smoothly rather than in steps.
  return (shape[index] ?? 0.5) * (1 - fraction) + (shape[next] ?? 0.5) * fraction;
}

export class SimulatedMeter {
  readonly slaveId: number;
  private readonly peakKw: number;
  private readonly nominalVoltage: number;
  private readonly random: () => number;
  private readonly timezone: string;

  private energyImportKwh: number;
  private energyExportKwh = 0;
  private reactiveEnergyKvarh: number;
  private maxDemandKw = 0;
  private lastSampleMs: number | null = null;

  constructor(options: SimulatorMeterOptions) {
    this.slaveId = options.slaveId;
    this.peakKw = options.peakKw ?? 45 + options.slaveId * 7;
    this.nominalVoltage = options.nominalVoltage ?? 230;
    this.random = makeRandom(options.seed ?? options.slaveId * 7919 + 13);
    this.timezone = options.timezone ?? 'Asia/Kolkata';
    this.energyImportKwh = options.startKwh ?? 14000 + options.slaveId * 1500;
    this.reactiveEnergyKvarh = this.energyImportKwh * 0.3;
  }

  private localHour(at: Date): number {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: this.timezone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(at);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
    return (hour % 24) + minute / 60;
  }

  private jitter(spread: number): number {
    return (this.random() - 0.5) * 2 * spread;
  }

  /**
   * Produce the reading for instant `at`.
   *
   * Energy accrues from the elapsed time since the previous sample, so the
   * counter stays consistent whether the simulator is running live or
   * back-filling a buffered batch.
   */
  sample(at: Date): SimulatedReading {
    const nowMs = at.getTime();
    const elapsedHours =
      this.lastSampleMs === null ? 0 : Math.max(0, (nowMs - this.lastSampleMs) / 3_600_000);
    this.lastSampleMs = nowMs;

    const load = loadProfile(this.localHour(at)) * (1 + this.jitter(0.04));
    const activeKw = Math.max(0.4, this.peakKw * load);

    // Voltage sags a little as load rises, as it does on a real feeder.
    const sag = (activeKw / this.peakKw) * 4.5;
    const v1 = this.nominalVoltage - sag + this.jitter(1.6);
    const v2 = this.nominalVoltage - sag + this.jitter(1.6);
    const v3 = this.nominalVoltage - sag + this.jitter(1.6);

    const powerFactor = Math.min(0.99, Math.max(0.78, 0.86 + load * 0.12 + this.jitter(0.015)));
    const apparentKva = activeKw / powerFactor;
    const reactiveKvar = Math.sqrt(Math.max(0, apparentKva ** 2 - activeKw ** 2));

    const perPhaseKw = activeKw / 3;
    const current = (voltage: number): number => (perPhaseKw * 1000) / Math.max(voltage, 1) / powerFactor;

    this.energyImportKwh += activeKw * elapsedHours;
    this.reactiveEnergyKvarh += reactiveKvar * elapsedHours;
    this.maxDemandKw = Math.max(this.maxDemandKw, activeKw);

    const round = (value: number, decimals = 2): number => {
      const factor = 10 ** decimals;
      return Math.round(value * factor) / factor;
    };

    return {
      voltage_l1: round(v1, 1),
      voltage_l2: round(v2, 1),
      voltage_l3: round(v3, 1),
      voltage_l12: round((v1 + v2) / 2 * Math.sqrt(3), 1),
      voltage_l23: round((v2 + v3) / 2 * Math.sqrt(3), 1),
      voltage_l31: round((v3 + v1) / 2 * Math.sqrt(3), 1),
      current_l1: round(current(v1), 2),
      current_l2: round(current(v2) * (1 + this.jitter(0.03)), 2),
      current_l3: round(current(v3) * (1 + this.jitter(0.03)), 2),
      active_power_kw: round(activeKw, 3),
      reactive_power_kvar: round(reactiveKvar, 3),
      apparent_power_kva: round(apparentKva, 3),
      power_factor: round(powerFactor, 3),
      frequency_hz: round(50 + this.jitter(0.04), 2),
      energy_import_kwh: round(this.energyImportKwh, 3),
      energy_export_kwh: round(this.energyExportKwh, 3),
      reactive_energy_kvarh: round(this.reactiveEnergyKvarh, 3),
      demand_kw: round(this.maxDemandKw, 3),
    };
  }

  /** Rewind the internal clock so a historical back-fill accrues correctly. */
  primeAt(at: Date): void {
    this.lastSampleMs = at.getTime();
  }
}
