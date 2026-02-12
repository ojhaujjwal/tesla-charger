import type { IEventLogger, SessionSummary } from "./types.js";
import { Effect } from "effect";

export class EventLogger implements IEventLogger {

  public onSetAmpere(ampere: number) {
    return Effect.log(`Setting charging rate to ${ampere}A`);
  }

  public onNoAmpereChange(currentChargingAmpere: number) {
    return Effect.log(`No ampere change. Current charging ampere: ${currentChargingAmpere}`);
  }

  public onSessionEnd(summary: SessionSummary) {
    return Effect.log('Session ended', {
      sessionDurationMs: summary.sessionDurationMs,
      totalEnergyChargedKwh: summary.totalEnergyChargedKwh,
      gridImportKwh: summary.gridImportKwh,
      solarEnergyUsedKwh: summary.solarEnergyUsedKwh,
      averageChargingSpeedAmps: summary.averageChargingSpeedAmps,
      ampereFluctuations: summary.ampereFluctuations,
      gridImportCost: summary.gridImportCost,
    });
  }
}
