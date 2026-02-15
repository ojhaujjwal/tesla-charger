import { describe, it, vitest, beforeEach, expect } from '@effect/vitest';
import type { MockedObject } from '@effect/vitest';
import { Effect, Duration, Fiber, Layer, PubSub, TestClock } from 'effect';
import { TeslaClient } from '../../tesla-client/index.js';
import { ChargeStateQueryFailedError } from '../../tesla-client/errors.js';
import { BatteryStateManager, BatteryStateManagerLayer } from '../../battery-state-manager.js';
import type { TeslaChargerEvent } from '../../events.js';

describe('BatteryStateManager', () => {
  const teslaClientMock: MockedObject<TeslaClient> = {
    authenticateFromAuthCodeGrant: vitest.fn(),
    refreshAccessToken: vitest.fn(),
    setupAccessTokenAutoRefreshRecurring: vitest.fn(),
    startCharging: vitest.fn(),
    stopCharging: vitest.fn(),
    setAmpere: vitest.fn(),
    wakeUpCar: vitest.fn(),
    getChargeState: vitest.fn(),
    saveTokens: vitest.fn(),
  };

  const TestTeslaClient = Layer.succeed(TeslaClient, teslaClientMock);

  const provideBatteryStateManagerLayer = (effect: Effect.Effect<void, unknown, BatteryStateManager>) =>
    effect.pipe(
      Effect.provide(BatteryStateManagerLayer.pipe(Layer.provideMerge(TestTeslaClient)))
    );

  beforeEach(() => {
    vitest.clearAllMocks();
    teslaClientMock.getChargeState.mockReturnValue(
      Effect.succeed({ batteryLevel: 50, chargeLimitSoc: 80, chargeEnergyAdded: 0 })
    );
  });

  it.effect('should populate batteryState at startup from getChargeState', () =>
    Effect.gen(function* () {
      teslaClientMock.getChargeState.mockReturnValue(
        Effect.succeed({ batteryLevel: 45, chargeLimitSoc: 80, chargeEnergyAdded: 1.2 })
      );

      const batteryStateManager = yield* BatteryStateManager;
      const pubSub = yield* PubSub.unbounded<TeslaChargerEvent>();
      const fiber = yield* batteryStateManager.start(pubSub).pipe(Effect.fork);

      // Wait a bit for initial fetch
      yield* TestClock.adjust(Duration.millis(100));

      // getChargeState should have been called once at startup
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

  it.effect('should handle TeslaClient failure gracefully at startup', () =>
    Effect.gen(function* () {
      teslaClientMock.getChargeState.mockReturnValue(
        Effect.fail(new ChargeStateQueryFailedError({ message: 'Vehicle is asleep' }))
      );

      const batteryStateManager = yield* BatteryStateManager;
      const pubSub = yield* PubSub.unbounded<TeslaChargerEvent>();
      const fiber = yield* batteryStateManager.start(pubSub).pipe(Effect.fork);

      // Wait a bit for initial fetch attempt
      yield* TestClock.adjust(Duration.millis(100));

      // getChargeState should have been called
      expect(teslaClientMock.getChargeState).toHaveBeenCalled();

      // State should be null (failed to fetch)
      const state = batteryStateManager.get();
      expect(state).toBeNull();

      yield* Fiber.interrupt(fiber);
      yield* PubSub.shutdown(pubSub);
    }).pipe(provideBatteryStateManagerLayer)
  );

  it.effect('should not refresh batteryState when ampere changes but cooldown has not elapsed', () =>
    Effect.gen(function* () {
      const batteryStateManager = yield* BatteryStateManager;
      const pubSub = yield* PubSub.unbounded<TeslaChargerEvent>();
      const fiber = yield* batteryStateManager.start(pubSub).pipe(Effect.fork);

      // Wait for initial fetch
      yield* TestClock.adjust(Duration.millis(100));
      expect(teslaClientMock.getChargeState).toHaveBeenCalledTimes(1);

      // Publish ampere changed event (within cooldown period)
      yield* PubSub.publish(pubSub, {
        _tag: 'AmpereChanged' as const,
        previous: 0,
        current: 10,
      });

      // Wait a bit
      yield* TestClock.adjust(Duration.millis(100));

      // getChargeState should still only have been called once (no refresh)
      expect(teslaClientMock.getChargeState).toHaveBeenCalledTimes(1);

      yield* Fiber.interrupt(fiber);
      yield* PubSub.shutdown(pubSub);
    }).pipe(provideBatteryStateManagerLayer)
  );

  it.effect('should refresh batteryState when ampere changes and cooldown has elapsed', () =>
    Effect.gen(function* () {
      let getChargeStateCallCount = 0;
      teslaClientMock.getChargeState.mockImplementation(() => {
        getChargeStateCallCount++;
        if (getChargeStateCallCount === 1) {
          return Effect.succeed({ batteryLevel: 50, chargeLimitSoc: 80, chargeEnergyAdded: 0 });
        }
        // Refreshed state shows higher battery level
        return Effect.succeed({ batteryLevel: 62, chargeLimitSoc: 80, chargeEnergyAdded: 5.0 });
      });

      const batteryStateManager = yield* BatteryStateManager;
      const pubSub = yield* PubSub.unbounded<TeslaChargerEvent>();
      const fiber = yield* batteryStateManager.start(pubSub).pipe(Effect.fork);

      // Wait for initial fetch
      yield* TestClock.adjust(Duration.millis(100));
      expect(teslaClientMock.getChargeState).toHaveBeenCalledTimes(1);

      // Advance past cooldown (10 minutes)
      yield* TestClock.adjust(Duration.minutes(11));

      // Publish ampere changed event
      yield* PubSub.publish(pubSub, {
        _tag: 'AmpereChanged' as const,
        previous: 10,
        current: 15,
      });

      // Wait a bit for refresh
      yield* TestClock.adjust(Duration.millis(100));

      // getChargeState should now have been called twice: startup + refresh
      expect(teslaClientMock.getChargeState).toHaveBeenCalledTimes(2);

      // Verify state was updated
      const state = batteryStateManager.get();
      expect(state?.batteryLevel).toBe(62);

      yield* Fiber.interrupt(fiber);
      yield* PubSub.shutdown(pubSub);
    }).pipe(provideBatteryStateManagerLayer)
  );

  it.effect('should keep old batteryState if refresh fails', () =>
    Effect.gen(function* () {
      let getChargeStateCallCount = 0;
      teslaClientMock.getChargeState.mockImplementation(() => {
        getChargeStateCallCount++;
        if (getChargeStateCallCount === 1) {
          return Effect.succeed({ batteryLevel: 50, chargeLimitSoc: 80, chargeEnergyAdded: 0 });
        }
        // Subsequent calls fail
        return Effect.fail(new ChargeStateQueryFailedError({ message: 'Vehicle is asleep' }));
      });

      const batteryStateManager = yield* BatteryStateManager;
      const pubSub = yield* PubSub.unbounded<TeslaChargerEvent>();
      const fiber = yield* batteryStateManager.start(pubSub).pipe(Effect.fork);

      // Wait for initial fetch
      yield* TestClock.adjust(Duration.millis(100));
      const initialState = batteryStateManager.get();
      expect(initialState?.batteryLevel).toBe(50);

      // Advance past cooldown
      yield* TestClock.adjust(Duration.minutes(11));

      // Publish ampere changed event (triggers refresh that fails)
      yield* PubSub.publish(pubSub, {
        _tag: 'AmpereChanged' as const,
        previous: 10,
        current: 15,
      });

      // Wait a bit for refresh attempt
      yield* TestClock.adjust(Duration.millis(100));

      // getChargeState called twice (startup + failed refresh attempt)
      expect(teslaClientMock.getChargeState).toHaveBeenCalledTimes(2);

      // State should still be the old value (refresh failed)
      const state = batteryStateManager.get();
      expect(state?.batteryLevel).toBe(50);

      yield* Fiber.interrupt(fiber);
      yield* PubSub.shutdown(pubSub);
    }).pipe(provideBatteryStateManagerLayer)
  );

  it.effect('should stop listening when PubSub is shut down', () =>
    Effect.gen(function* () {
      const batteryStateManager = yield* BatteryStateManager;
      const pubSub = yield* PubSub.unbounded<TeslaChargerEvent>();
      const fiber = yield* batteryStateManager.start(pubSub).pipe(Effect.fork);

      // Wait for initial fetch
      yield* TestClock.adjust(Duration.millis(100));
      expect(teslaClientMock.getChargeState).toHaveBeenCalledTimes(1);

      // Shut down the PubSub — interrupts the subscriber
      yield* PubSub.shutdown(pubSub);

      // Wait a bit
      yield* TestClock.adjust(Duration.millis(100));

      // Fiber should be done (listener stopped)
      const status = yield* Fiber.status(fiber);
      expect(status._tag).toBe('Done');
    }).pipe(provideBatteryStateManagerLayer)
  );
});
