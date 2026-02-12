import type { Effect } from "effect";

export type SessionSummary = {
  sessionDurationMs: number;
  totalEnergyChargedKwh: number;
  gridImportKwh: number;
  solarEnergyUsedKwh: number;
  averageChargingSpeedAmps: number;
  ampereFluctuations: number;
  gridImportCost: number;
};

export type IEventLogger = {
  onSetAmpere: (ampere: number) => Effect.Effect<void>;
  onNoAmpereChange: (currentChargingAmpere: number) => Effect.Effect<void>;
  onSessionEnd: (summary: SessionSummary) => Effect.Effect<void>;
};
