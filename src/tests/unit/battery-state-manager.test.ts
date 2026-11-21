import { describe, it, expect } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import { Effect, Deferred, Duration, Fiber, Layer, PubSub } from "effect";
import { ChargeStateQueryFailedError } from "../../tesla-client/errors.js";
import { BatteryStateManager } from "../../battery-state-manager.js";
import type { TeslaChargerEvent } from "../../domain/events.js";
import { Ampere, KiloWattHours as KWh, StateOfCharge } from "../../domain/brands.js";
import { makeTeslaClientTest, type TeslaClientTest } from "../fixtures/tesla-client.js";

describe("BatteryStateManager", () => {
  const TestLayer = (tesla: TeslaClientTest) => BatteryStateManager.layer.pipe(Layer.provideMerge(tesla.layer));

  const startManager = Effect.gen(function* () {
    const manager = yield* BatteryStateManager;
    const pubSub = yield* PubSub.unbounded<TeslaChargerEvent>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(pubSub));
    const fiber = yield* Effect.forkChild(manager.start(pubSub));
    return { manager, pubSub, fiber };
  });

  it.effect("should fetch battery state on first charging event (deferred from startup)", () => {
    const tesla = makeTeslaClientTest();
    tesla.client.getChargeState.mockReturnValue(
      Effect.succeed({
        batteryLevel: StateOfCharge(45),
        chargeLimitSoc: StateOfCharge(80),
        chargeEnergyAdded: KWh(1.2)
      })
    );

    return Effect.gen(function* () {
      const { manager, pubSub } = yield* startManager;

      // Wait a bit — no fetch at startup
      yield* TestClock.adjust(Duration.millis(100));
      expect(tesla.client.getChargeState).not.toHaveBeenCalled();
      expect(yield* manager.get).toBeNull();

      // Publish the first AmpereChangeInitiated event — should trigger fetch
      // because batteryState is null (timeSinceLastQuery = Infinity)
      yield* PubSub.publish(pubSub, {
        _tag: "AmpereChangeInitiated" as const,
        previous: Ampere(0),
        current: Ampere(10)
      });

      yield* TestClock.adjust(Duration.millis(100));

      expect(tesla.client.getChargeState).toHaveBeenCalledTimes(1);

      const state = yield* manager.get;
      expect(state).not.toBeNull();
      expect(state?.batteryLevel).toBe(45);
      expect(state?.chargeLimitSoc).toBe(80);
    }).pipe(Effect.provide(TestLayer(tesla)));
  });

  it.effect("should handle TeslaClient failure gracefully on first fetch", () => {
    const tesla = makeTeslaClientTest();
    tesla.client.getChargeState.mockReturnValue(
      Effect.fail(new ChargeStateQueryFailedError({ message: "Vehicle is asleep" }))
    );

    return Effect.gen(function* () {
      const { manager, pubSub } = yield* startManager;

      yield* TestClock.adjust(Duration.millis(100));

      // Publish event to trigger first fetch
      yield* PubSub.publish(pubSub, {
        _tag: "AmpereChangeInitiated" as const,
        previous: Ampere(0),
        current: Ampere(5)
      });

      yield* TestClock.adjust(Duration.millis(100));

      expect(tesla.client.getChargeState).toHaveBeenCalledTimes(1);
      expect(yield* manager.get).toBeNull();
    }).pipe(Effect.provide(TestLayer(tesla)));
  });

  it.effect("should not refresh batteryState when ampere changes but cooldown has not elapsed", () => {
    const tesla = makeTeslaClientTest();

    return Effect.gen(function* () {
      const { pubSub } = yield* startManager;

      yield* TestClock.adjust(Duration.millis(100));

      yield* PubSub.publish(pubSub, {
        _tag: "AmpereChangeInitiated" as const,
        previous: Ampere(0),
        current: Ampere(10)
      });

      yield* TestClock.adjust(Duration.millis(100));
      expect(tesla.client.getChargeState).toHaveBeenCalledTimes(1);

      // Second AmpereChangeInitiated within cooldown period
      yield* PubSub.publish(pubSub, {
        _tag: "AmpereChangeInitiated" as const,
        previous: Ampere(10),
        current: Ampere(15)
      });

      yield* TestClock.adjust(Duration.millis(100));

      expect(tesla.client.getChargeState).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(TestLayer(tesla)));
  });

  it.effect("should refresh batteryState when ampere changes and cooldown has elapsed", () => {
    const tesla = makeTeslaClientTest();
    let getChargeStateCallCount = 0;
    tesla.client.getChargeState.mockImplementation(() => {
      getChargeStateCallCount++;
      if (getChargeStateCallCount === 1) {
        return Effect.succeed({
          batteryLevel: StateOfCharge(50),
          chargeLimitSoc: StateOfCharge(80),
          chargeEnergyAdded: KWh(0)
        });
      }
      return Effect.succeed({
        batteryLevel: StateOfCharge(62),
        chargeLimitSoc: StateOfCharge(80),
        chargeEnergyAdded: KWh(5.0)
      });
    });

    return Effect.gen(function* () {
      const { manager, pubSub } = yield* startManager;

      yield* TestClock.adjust(Duration.millis(100));

      // First AmpereChanged triggers the initial fetch
      yield* PubSub.publish(pubSub, {
        _tag: "AmpereChangeInitiated" as const,
        previous: Ampere(0),
        current: Ampere(10)
      });

      yield* TestClock.adjust(Duration.millis(100));
      expect(tesla.client.getChargeState).toHaveBeenCalledTimes(1);

      // Advance past cooldown (10 minutes)
      yield* TestClock.adjust(Duration.minutes(11));

      // Second AmpereChangeInitiated after cooldown — should trigger refresh
      yield* PubSub.publish(pubSub, {
        _tag: "AmpereChangeInitiated" as const,
        previous: Ampere(10),
        current: Ampere(15)
      });

      yield* TestClock.adjust(Duration.millis(100));

      expect(tesla.client.getChargeState).toHaveBeenCalledTimes(2);

      const state = yield* manager.get;
      expect(state?.batteryLevel).toBe(62);
    }).pipe(Effect.provide(TestLayer(tesla)));
  });

  it.effect("should refresh exactly at the ten-minute cooldown boundary", () => {
    const tesla = makeTeslaClientTest();

    return Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);

      const { manager, pubSub } = yield* startManager;
      yield* Effect.yieldNow;

      yield* PubSub.publish(pubSub, { _tag: "ChargingStarted" as const });
      yield* Effect.yieldNow;
      expect((yield* manager.get)?.queriedAtMs).toBe(1_000_000);

      yield* TestClock.adjust(Duration.minutes(10));

      yield* PubSub.publish(pubSub, {
        _tag: "AmpereChangeInitiated" as const,
        previous: Ampere(0),
        current: Ampere(10)
      });
      yield* Effect.yieldNow;

      expect(tesla.client.getChargeState).toHaveBeenCalledTimes(2);
      expect((yield* manager.get)?.queriedAtMs).toBe(1_600_000);
    }).pipe(Effect.provide(TestLayer(tesla)));
  });

  it.effect("should keep old batteryState if refresh fails", () => {
    const tesla = makeTeslaClientTest();
    let getChargeStateCallCount = 0;
    tesla.client.getChargeState.mockImplementation(() => {
      getChargeStateCallCount++;
      if (getChargeStateCallCount === 1) {
        return Effect.succeed({
          batteryLevel: StateOfCharge(50),
          chargeLimitSoc: StateOfCharge(80),
          chargeEnergyAdded: KWh(0)
        });
      }
      return Effect.fail(new ChargeStateQueryFailedError({ message: "Vehicle is asleep" }));
    });

    return Effect.gen(function* () {
      const { manager, pubSub } = yield* startManager;

      yield* TestClock.adjust(Duration.millis(100));

      // First AmpereChanged triggers the initial fetch
      yield* PubSub.publish(pubSub, {
        _tag: "AmpereChangeInitiated" as const,
        previous: Ampere(0),
        current: Ampere(10)
      });

      yield* TestClock.adjust(Duration.millis(100));
      const initialState = yield* manager.get;
      expect(initialState?.batteryLevel).toBe(50);

      // Advance past cooldown
      yield* TestClock.adjust(Duration.minutes(11));

      // Publish ampere changed event (triggers refresh that fails)
      yield* PubSub.publish(pubSub, {
        _tag: "AmpereChangeInitiated" as const,
        previous: Ampere(10),
        current: Ampere(15)
      });

      yield* TestClock.adjust(Duration.millis(100));

      expect(tesla.client.getChargeState).toHaveBeenCalledTimes(2);

      const state = yield* manager.get;
      expect(state?.batteryLevel).toBe(50);
    }).pipe(Effect.provide(TestLayer(tesla)));
  });

  it.effect("should expose the manager's state to a reader fiber forked before the first fetch", () => {
    const tesla = makeTeslaClientTest();

    return Effect.gen(function* () {
      const manager = yield* BatteryStateManager;

      const gate = yield* Deferred.make<void>();
      const readerFiber = yield* Effect.gen(function* () {
        yield* Deferred.await(gate);
        return yield* manager.get;
      }).pipe(Effect.forkChild);

      const { pubSub } = yield* startManager;

      yield* TestClock.adjust(Duration.millis(100));
      expect(yield* manager.get).toBeNull();

      yield* PubSub.publish(pubSub, { _tag: "ChargingStarted" as const });
      yield* TestClock.adjust(Duration.millis(100));

      yield* Deferred.succeed(gate, undefined);
      const state = yield* Fiber.join(readerFiber);
      expect(state?.batteryLevel).toBe(50);
    }).pipe(Effect.provide(TestLayer(tesla)));
  });

  it.effect("should stop listening when PubSub is shut down", () => {
    const tesla = makeTeslaClientTest();

    return Effect.gen(function* () {
      const { pubSub, fiber } = yield* startManager;

      yield* TestClock.adjust(Duration.millis(100));

      expect(tesla.client.getChargeState).not.toHaveBeenCalled();

      // Shut down the PubSub — interrupts the subscriber
      yield* PubSub.shutdown(pubSub);
      yield* TestClock.adjust(Duration.millis(100));

      const status = fiber.pollUnsafe();
      expect(status).not.toBeUndefined();
    }).pipe(Effect.provide(TestLayer(tesla)));
  });
});
