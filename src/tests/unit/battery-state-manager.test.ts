import { describe, it, vitest, beforeEach, expect } from "@effect/vitest";
import type { MockedObject } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import { Effect, Duration, Fiber, Layer, PubSub } from "effect";
import { TeslaClient, type TeslaClientService } from "../../tesla-client/index.js";
import { ChargeStateQueryFailedError } from "../../tesla-client/errors.js";
import { BatteryStateManager } from "../../battery-state-manager.js";
import type { TeslaChargerEvent } from "../../domain/events.js";
import { Ampere, KiloWattHours as KWh, StateOfCharge } from "../../domain/brands.js";

describe("BatteryStateManager", () => {
  const teslaClientMock: MockedObject<TeslaClientService> = {
    authenticateFromAuthCodeGrant: vitest.fn(),
    refreshAccessToken: vitest.fn(),
    setupAccessTokenAutoRefreshRecurring: vitest.fn(),
    startCharging: vitest.fn(),
    stopCharging: vitest.fn(),
    setAmpere: vitest.fn(),
    wakeUpCar: vitest.fn(),
    getChargeState: vitest.fn()
  };

  const TestTeslaClient = Layer.succeed(TeslaClient, teslaClientMock);

  const provideBatteryStateManagerLayer = (effect: Effect.Effect<void, never, BatteryStateManager>) =>
    effect.pipe(Effect.provide(BatteryStateManager.layer.pipe(Layer.provideMerge(TestTeslaClient))));

  beforeEach(() => {
    vitest.clearAllMocks();
    teslaClientMock.getChargeState.mockReturnValue(
      Effect.succeed({ batteryLevel: StateOfCharge(50), chargeLimitSoc: StateOfCharge(80), chargeEnergyAdded: KWh(0) })
    );
  });

  it.effect("should fetch battery state on first charging event (deferred from startup)", () =>
    Effect.gen(function* () {
      teslaClientMock.getChargeState.mockReturnValue(
        Effect.succeed({
          batteryLevel: StateOfCharge(45),
          chargeLimitSoc: StateOfCharge(80),
          chargeEnergyAdded: KWh(1.2)
        })
      );

      const batteryStateManager = yield* BatteryStateManager;
      const pubSub = yield* PubSub.unbounded<TeslaChargerEvent>();
      const fiber = yield* batteryStateManager.start(pubSub).pipe(Effect.forkChild);

      // Wait a bit — no fetch at startup
      yield* TestClock.adjust(Duration.millis(100));
      expect(teslaClientMock.getChargeState).not.toHaveBeenCalled();
      expect(batteryStateManager.get()).toBeNull();

      // Publish the first AmpereChangeInitiated event — should trigger fetch
      // because batteryState is null (timeSinceLastQuery = Infinity)
      yield* PubSub.publish(pubSub, {
        _tag: "AmpereChangeInitiated" as const,
        previous: Ampere(0),
        current: Ampere(10)
      });

      yield* TestClock.adjust(Duration.millis(100));

      expect(teslaClientMock.getChargeState).toHaveBeenCalledTimes(1);

      // Verify state was populated
      const state = batteryStateManager.get();
      expect(state).not.toBeNull();
      expect(state?.batteryLevel).toBe(45);
      expect(state?.chargeLimitSoc).toBe(80);

      yield* Fiber.interrupt(fiber);
      yield* PubSub.shutdown(pubSub);
    }).pipe(provideBatteryStateManagerLayer)
  );

  it.effect("should handle TeslaClient failure gracefully on first fetch", () =>
    Effect.gen(function* () {
      teslaClientMock.getChargeState.mockReturnValue(
        Effect.fail(new ChargeStateQueryFailedError({ message: "Vehicle is asleep" }))
      );

      const batteryStateManager = yield* BatteryStateManager;
      const pubSub = yield* PubSub.unbounded<TeslaChargerEvent>();
      const fiber = yield* batteryStateManager.start(pubSub).pipe(Effect.forkChild);

      yield* TestClock.adjust(Duration.millis(100));

      // Publish event to trigger first fetch
      yield* PubSub.publish(pubSub, {
        _tag: "AmpereChangeInitiated" as const,
        previous: Ampere(0),
        current: Ampere(5)
      });

      yield* TestClock.adjust(Duration.millis(100));

      expect(teslaClientMock.getChargeState).toHaveBeenCalledTimes(1);

      // State should be null (failed to fetch)
      const state = batteryStateManager.get();
      expect(state).toBeNull();

      yield* Fiber.interrupt(fiber);
      yield* PubSub.shutdown(pubSub);
    }).pipe(provideBatteryStateManagerLayer)
  );

  it.effect("should not refresh batteryState when ampere changes but cooldown has not elapsed", () =>
    Effect.gen(function* () {
      const batteryStateManager = yield* BatteryStateManager;
      const pubSub = yield* PubSub.unbounded<TeslaChargerEvent>();
      const fiber = yield* batteryStateManager.start(pubSub).pipe(Effect.forkChild);

      yield* TestClock.adjust(Duration.millis(100));

      yield* PubSub.publish(pubSub, {
        _tag: "AmpereChangeInitiated" as const,
        previous: Ampere(0),
        current: Ampere(10)
      });

      yield* TestClock.adjust(Duration.millis(100));
      expect(teslaClientMock.getChargeState).toHaveBeenCalledTimes(1);

      // Second AmpereChangeInitiated within cooldown period
      yield* PubSub.publish(pubSub, {
        _tag: "AmpereChangeInitiated" as const,
        previous: Ampere(10),
        current: Ampere(15)
      });

      yield* TestClock.adjust(Duration.millis(100));

      // getChargeState should still only have been called once (no refresh)
      expect(teslaClientMock.getChargeState).toHaveBeenCalledTimes(1);

      yield* Fiber.interrupt(fiber);
      yield* PubSub.shutdown(pubSub);
    }).pipe(provideBatteryStateManagerLayer)
  );

  it.effect("should refresh batteryState when ampere changes and cooldown has elapsed", () =>
    Effect.gen(function* () {
      let getChargeStateCallCount = 0;
      teslaClientMock.getChargeState.mockImplementation(() => {
        getChargeStateCallCount++;
        if (getChargeStateCallCount === 1) {
          return Effect.succeed({
            batteryLevel: StateOfCharge(50),
            chargeLimitSoc: StateOfCharge(80),
            chargeEnergyAdded: KWh(0)
          });
        }
        // Refreshed state shows higher battery level
        return Effect.succeed({
          batteryLevel: StateOfCharge(62),
          chargeLimitSoc: StateOfCharge(80),
          chargeEnergyAdded: KWh(5.0)
        });
      });

      const batteryStateManager = yield* BatteryStateManager;
      const pubSub = yield* PubSub.unbounded<TeslaChargerEvent>();
      const fiber = yield* batteryStateManager.start(pubSub).pipe(Effect.forkChild);

      yield* TestClock.adjust(Duration.millis(100));

      // First AmpereChanged triggers the initial fetch
      yield* PubSub.publish(pubSub, {
        _tag: "AmpereChangeInitiated" as const,
        previous: Ampere(0),
        current: Ampere(10)
      });

      yield* TestClock.adjust(Duration.millis(100));
      expect(teslaClientMock.getChargeState).toHaveBeenCalledTimes(1);

      // Advance past cooldown (10 minutes)
      yield* TestClock.adjust(Duration.minutes(11));

      // Second AmpereChangeInitiated after cooldown — should trigger refresh
      yield* PubSub.publish(pubSub, {
        _tag: "AmpereChangeInitiated" as const,
        previous: Ampere(10),
        current: Ampere(15)
      });

      // Wait a bit for refresh
      yield* TestClock.adjust(Duration.millis(100));

      // getChargeState should now have been called twice: first event + refresh
      expect(teslaClientMock.getChargeState).toHaveBeenCalledTimes(2);

      // Verify state was updated
      const state = batteryStateManager.get();
      expect(state?.batteryLevel).toBe(62);

      yield* Fiber.interrupt(fiber);
      yield* PubSub.shutdown(pubSub);
    }).pipe(provideBatteryStateManagerLayer)
  );

  it.effect("should keep old batteryState if refresh fails", () =>
    Effect.gen(function* () {
      let getChargeStateCallCount = 0;
      teslaClientMock.getChargeState.mockImplementation(() => {
        getChargeStateCallCount++;
        if (getChargeStateCallCount === 1) {
          return Effect.succeed({
            batteryLevel: StateOfCharge(50),
            chargeLimitSoc: StateOfCharge(80),
            chargeEnergyAdded: KWh(0)
          });
        }
        // Subsequent calls fail
        return Effect.fail(new ChargeStateQueryFailedError({ message: "Vehicle is asleep" }));
      });

      const batteryStateManager = yield* BatteryStateManager;
      const pubSub = yield* PubSub.unbounded<TeslaChargerEvent>();
      const fiber = yield* batteryStateManager.start(pubSub).pipe(Effect.forkChild);

      yield* TestClock.adjust(Duration.millis(100));

      // First AmpereChanged triggers the initial fetch
      yield* PubSub.publish(pubSub, {
        _tag: "AmpereChangeInitiated" as const,
        previous: Ampere(0),
        current: Ampere(10)
      });

      yield* TestClock.adjust(Duration.millis(100));
      const initialState = batteryStateManager.get();
      expect(initialState?.batteryLevel).toBe(50);

      // Advance past cooldown
      yield* TestClock.adjust(Duration.minutes(11));

      // Publish ampere changed event (triggers refresh that fails)
      yield* PubSub.publish(pubSub, {
        _tag: "AmpereChangeInitiated" as const,
        previous: Ampere(10),
        current: Ampere(15)
      });

      // Wait a bit for refresh attempt
      yield* TestClock.adjust(Duration.millis(100));

      // getChargeState called twice (first event + failed refresh attempt)
      expect(teslaClientMock.getChargeState).toHaveBeenCalledTimes(2);

      // State should still be the old value (refresh failed)
      const state = batteryStateManager.get();
      expect(state?.batteryLevel).toBe(50);

      yield* Fiber.interrupt(fiber);
      yield* PubSub.shutdown(pubSub);
    }).pipe(provideBatteryStateManagerLayer)
  );

  it.effect("should stop listening when PubSub is shut down", () =>
    Effect.gen(function* () {
      const batteryStateManager = yield* BatteryStateManager;
      const pubSub = yield* PubSub.unbounded<TeslaChargerEvent>();
      const fiber = yield* batteryStateManager.start(pubSub).pipe(Effect.forkChild);

      // Wait a bit
      yield* TestClock.adjust(Duration.millis(100));

      // No calls at startup
      expect(teslaClientMock.getChargeState).not.toHaveBeenCalled();

      // Shut down the PubSub — interrupts the subscriber
      yield* PubSub.shutdown(pubSub);

      // Wait a bit
      yield* TestClock.adjust(Duration.millis(100));

      // Fiber should be done (listener stopped)
      const status = fiber.pollUnsafe();
      expect(status).not.toBeUndefined();
    }).pipe(provideBatteryStateManagerLayer)
  );
});
