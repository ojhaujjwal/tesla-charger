import { Context, Clock, Effect, Layer, PubSub } from "effect";
import { TeslaClient } from "./tesla-client/index.js";
import type { TeslaChargerEvent } from "./domain/events.js";

export type BatteryState = {
  batteryLevel: number;
  chargeLimitSoc: number;
  queriedAtMs: number; // epoch millis from Effect Clock (testable)
};

const BATTERY_STATE_REFRESH_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

export class BatteryStateManager extends Context.Tag("@tesla-charger/BatteryStateManager")<
  BatteryStateManager,
  {
    readonly start: (pubSub: PubSub.PubSub<TeslaChargerEvent>) => Effect.Effect<void>;
    readonly get: () => BatteryState | null;
  }
>() {}

export const BatteryStateManagerLayer = Layer.effect(
  BatteryStateManager,
  Effect.gen(function* () {
    const teslaClient = yield* TeslaClient;
    let batteryState: BatteryState | null = null;

    const fetchAndStoreBatteryState = () =>
      Effect.gen(function* () {
        const result = yield* teslaClient.getChargeState().pipe(
          Effect.catchAll((err) =>
            Effect.gen(function* () {
              yield* Effect.logWarning(`Failed to refresh battery state: ${err.message}`);
              return null;
            })
          )
        );

        if (result) {
          const now = yield* Clock.currentTimeMillis;
          batteryState = {
            batteryLevel: result.batteryLevel,
            chargeLimitSoc: result.chargeLimitSoc,
            queriedAtMs: now
          };
        }
      });

    const start = (pubSub: PubSub.PubSub<TeslaChargerEvent>) =>
      Effect.gen(function* () {
        // No initial fetch — the car may still be asleep at startup.
        // The first AmpereChanged event will trigger a fetch (since batteryState
        // is null, timeSinceLastQuery is Infinity and exceeds the cooldown).

        // Subscribe to events and process them
        const subscription = yield* PubSub.subscribe(pubSub);

        return yield* Effect.forever(
          Effect.gen(function* () {
            const event = yield* subscription.take;

            // Trigger battery state refresh on events that signal active charging
            if (
              event._tag === "ChargingStarted" ||
              event._tag === "AmpereChangeInitiated" ||
              event._tag === "AmpereChangeFinished"
            ) {
              const now = yield* Clock.currentTimeMillis;

              const timeSinceLastQuery = batteryState ? now - batteryState.queriedAtMs : Infinity;

              if (timeSinceLastQuery >= BATTERY_STATE_REFRESH_COOLDOWN_MS) {
                yield* Effect.logInfo(
                  `Refreshing battery state: ${event._tag}, last queried ${Math.round(timeSinceLastQuery / 60000)}min ago`
                );
                yield* fetchAndStoreBatteryState();
              }
            }
          })
        );
      }).pipe(Effect.scoped);

    const get = () => batteryState;

    return {
      start,
      get
    };
  })
);
