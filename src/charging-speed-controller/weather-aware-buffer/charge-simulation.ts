import type { WeatherAwareBufferConfig, SimulationResult } from "./types.js";
import { calculateDefaultMonthlyPeakFactors, expectedCapacityKw } from "./solar-calculations.js";
import { periodConfidence } from "./forecast-confidence.js";

// Pure function for simulating charge completion based on forecast

export const simulateCharge = (
  config: WeatherAwareBufferConfig,
  forecast: {
    readonly periods: readonly {
      readonly pv_estimate: number;
      readonly period_end: string;
    }[];
  },
  batteryState: {
    readonly batteryLevel: number;
    readonly chargeLimitSoc: number;
  } | null,
  now: Date
): SimulationResult => {
  if (!batteryState) {
    return {
      canComplete: false,
      usableSlots: 0,
      totalSlots: 0,
      utilizationRatio: 0,
      shortfallKwh: 0,
    };
  }

  // Calculate remaining charge need
  const remainingNeedKwh =
    ((batteryState.chargeLimitSoc - batteryState.batteryLevel) / 100) *
    config.carBatteryCapacityKwh;

  // Determine cutoff hour
  const cutoffHour =
    config.deadlineHour ?? config.solarCutoffHour;

  // Get monthly peak factors
  const monthlyPeakFactors =
    config.monthlyPeakFactors ??
    calculateDefaultMonthlyPeakFactors(config.latitude);

  let remainingNeed = remainingNeedKwh;
  let usableSlots = 0;
  let totalSlots = 0;
  const minChargingThresholdW = 690; // ~3A * 230V

  // Walk through forecast periods
  for (const period of forecast.periods) {
    const periodEnd = new Date(period.period_end);

    // Skip if period is before now
    if (periodEnd < now) {
      continue;
    }

    // Extract hour from timestamp
    // Note: Solcast API may return UTC timestamps, but we need local solar time for calculations
    // For simplicity, treat the hour component as local solar time
    // In production, ensure timestamps are converted to local timezone before calling this function
    const periodHourUtc = periodEnd.getUTCHours() + periodEnd.getUTCMinutes() / 60;
    
    // Use UTC hour directly as local hour (assumes API returns local time in UTC format)
    // TODO: Properly convert UTC to local timezone using location's timezone
    const localHour = periodHourUtc;

    // Check if period is after cutoff hour (cutoffHour is in local time)
    if (localHour >= cutoffHour) {
      continue;
    }

    totalSlots++;

    // Use the period date directly for solar calculations
    // (The date part is correct, we just use the hour as local time)
    const expectedCap = expectedCapacityKw(periodEnd, localHour, {
      ...config,
      monthlyPeakFactors,
    });

    // Calculate confidence
    const confidence = periodConfidence(period.pv_estimate, expectedCap);

    // Calculate effective buffer (higher when confidence is low)
    const effectiveBufferW =
      config.minBufferPower *
      (1 +
        (config.bufferMultiplierMax - 1) * (1 - confidence));

    // Calculate available power for car
    const productionW = period.pv_estimate * 1000;
    const availableForCarW = productionW - effectiveBufferW;

    // If we have enough power and remaining need, use this slot
    if (availableForCarW > minChargingThresholdW && remainingNeed > 0) {
      // Discount usable energy by confidence (cloudy periods are less reliable)
      const usableKwh = (availableForCarW / 1000) * 0.5 * confidence;
      remainingNeed -= usableKwh;
      usableSlots++;

      // If we've met the need, we can complete
      if (remainingNeed <= 0) {
        break;
      }
    }
  }

  // Allow small tolerance for floating point precision and near-complete charges
  // (0.3 kWh = ~1% of a 75kWh battery, acceptable rounding)
  const canComplete = remainingNeed <= 0.3;
  const utilizationRatio =
    totalSlots > 0 ? usableSlots / totalSlots : 0;
  const shortfallKwh = canComplete ? 0 : remainingNeed;

  return {
    canComplete,
    usableSlots,
    totalSlots,
    utilizationRatio,
    shortfallKwh,
  };
};
