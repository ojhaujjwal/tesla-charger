import type { Effect } from "effect";

export type IEventLogger = {
  onSetAmpere: (ampere: number) => Effect.Effect<void>;
  onNoAmpereChange: (currentChargingAmpere: number) => Effect.Effect<void>;
};
