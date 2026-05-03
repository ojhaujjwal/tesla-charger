import { Effect, PubSub, Queue } from "effect";
import type { TeslaChargerEvent } from "../domain/events.js";

export const startEventLogger = (pubSub: PubSub.PubSub<TeslaChargerEvent>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const subscription = yield* PubSub.subscribe(pubSub);
    return yield* Effect.forever(
      Effect.gen(function* () {
        const event = yield* Queue.take(subscription);
        switch (event._tag) {
          case "AmpereChangeInitiated":
            yield* Effect.log(`Setting charging rate to ${event.current}A`);
            return;
          case "SessionEnded":
            yield* Effect.log("Session ended", {
              sessionDurationMs: event.summary.sessionDurationMs,
              totalEnergyChargedKwh: event.summary.totalEnergyChargedKwh,
              gridImportKwh: event.summary.gridImportKwh,
              solarEnergyUsedKwh: event.summary.solarEnergyUsedKwh,
              averageChargingSpeedAmps: event.summary.averageChargingSpeedAmps,
              ampereFluctuations: event.summary.ampereFluctuations,
              gridImportCost: event.summary.gridImportCost
            });
            return;
          default:
            return;
        }
      })
    );
  }).pipe(Effect.scoped);
