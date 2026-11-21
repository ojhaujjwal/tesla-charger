import { Effect, Layer, PubSub } from "effect";
import { BatteryStateManager, type BatteryState } from "../../battery-state-manager.js";
import type { TeslaChargerEvent } from "../../domain/events.js";

export type BatteryStateManagerTest = {
  readonly layer: Layer.Layer<BatteryStateManager>;
  readonly events: ReadonlyArray<TeslaChargerEvent>;
  readonly setState: (state: BatteryState | null) => void;
  readonly interrupts: number;
};

/**
 * Battery state double that also records the event stream: `start` subscribes
 * like the real manager, so a test can observe what the app published.
 */
export const makeBatteryStateManagerTest = (initialState: BatteryState | null = null): BatteryStateManagerTest => {
  let state = initialState;
  const events: Array<TeslaChargerEvent> = [];
  let interrupts = 0;

  const start = (pubSub: PubSub.PubSub<TeslaChargerEvent>) =>
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(pubSub);
      // Looping on `take` is what lets `PubSub.shutdown` end this consumer:
      // shutdown interrupts a pending take.
      return yield* Effect.forever(
        PubSub.take(subscription).pipe(
          Effect.tap((event) =>
            Effect.sync(() => {
              events.push(event);
            })
          )
        )
      );
    }).pipe(
      Effect.scoped,
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          interrupts += 1;
        })
      )
    );

  return {
    layer: Layer.succeed(BatteryStateManager, { start, get: Effect.sync(() => state) }),
    events,
    setState: (next) => {
      state = next;
    },
    get interrupts() {
      return interrupts;
    }
  };
};
