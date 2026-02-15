import { Context, Clock, Effect, Layer, PubSub } from 'effect';
import { TeslaClient } from './tesla-client/index.js';
import type { TeslaChargerEvent } from './events.js';

export type BatteryState = {
  batteryLevel: number;
  chargeLimitSoc: number;
  queriedAtMs: number; // epoch millis from Effect Clock (testable)
};

const BATTERY_STATE_REFRESH_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

export type BatteryStateManager = {
  readonly start: (pubSub: PubSub.PubSub<TeslaChargerEvent>) => Effect.Effect<void>;
  readonly get: () => BatteryState | null;
};

export const BatteryStateManager = Context.GenericTag<BatteryStateManager>('@tesla-charger/BatteryStateManager');

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
            queriedAtMs: now,
          };
        }
      });

    const start = (pubSub: PubSub.PubSub<TeslaChargerEvent>) =>
      Effect.gen(function* () {
        // Initial fetch
        yield* fetchAndStoreBatteryState();

        // Subscribe to events and process them
        const subscription = yield* PubSub.subscribe(pubSub);

        return yield* Effect.forever(
          Effect.gen(function* () {
            const event = yield* subscription.take;

            // Handle AmpereChanged event
            if (event._tag === 'AmpereChanged') {
              const now = yield* Clock.currentTimeMillis;

              const timeSinceLastQuery = batteryState
                ? now - batteryState.queriedAtMs
                : Infinity;

              if (timeSinceLastQuery >= BATTERY_STATE_REFRESH_COOLDOWN_MS) {
                yield* Effect.logInfo(
                  `Refreshing battery state: ampere changed (${event.previous} -> ${event.current}), last queried ${Math.round(timeSinceLastQuery / 60000)}min ago`
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
      get,
    };
  })
);
