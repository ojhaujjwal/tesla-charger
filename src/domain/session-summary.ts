import type { ChargingSessionStats } from "./charging-session.js";

export type SessionSummary = {
  readonly sessionDurationMs: number;
  readonly totalEnergyChargedKwh: number;
  readonly gridImportKwh: number;
  readonly solarEnergyUsedKwh: number;
  readonly averageChargingSpeedAmps: number;
  readonly ampereFluctuations: number;
  readonly gridImportCost: number;
};

export const computeSessionSummary = (params: {
  readonly stats: ChargingSessionStats;
  readonly finalChargeEnergyAdded: number;
  readonly finalDailyImport: number;
  readonly finalVoltage: number;
  readonly costPerKwh: number;
}): SessionSummary => {
  const sessionDurationMs = params.stats.sessionStartedAt ? Date.now() - params.stats.sessionStartedAt.getTime() : 0;

  const totalEnergyChargedKwh = params.finalChargeEnergyAdded - params.stats.chargeEnergyAddedAtStartKwh;
  const gridImportKwh = params.finalDailyImport - params.stats.dailyImportValueAtStart;
  const solarEnergyUsedKwh = Math.max(0, totalEnergyChargedKwh - gridImportKwh);

  const sessionDurationHours = sessionDurationMs / 3_600_000;
  const averageChargingSpeedAmps =
    sessionDurationHours > 0 && params.finalVoltage > 0
      ? (totalEnergyChargedKwh * 1000) / (params.finalVoltage * sessionDurationHours)
      : 0;

  const gridImportCost = gridImportKwh * params.costPerKwh;

  return {
    sessionDurationMs,
    totalEnergyChargedKwh,
    gridImportKwh,
    solarEnergyUsedKwh,
    averageChargingSpeedAmps,
    ampereFluctuations: params.stats.ampereFluctuations,
    gridImportCost
  };
};
