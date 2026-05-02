import type { Effect } from "effect";
import type { SessionSummary } from "../domain/session-summary.js";

export type { SessionSummary } from "../domain/session-summary.js";

export type IEventLogger = {
  onSetAmpere: (ampere: number) => Effect.Effect<void>;
  onNoAmpereChange: (currentChargingAmpere: number) => Effect.Effect<void>;
  onSessionEnd: (summary: SessionSummary) => Effect.Effect<void>;
};
