import { describe, it, expect } from "@effect/vitest";
import { DateTime, Deferred, Duration, Effect, Fiber, Layer, PubSub, Ref } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { TeslaClient } from "../../tesla-client/index.js";
import {
  ChargeStateQueryFailedError,
  VehicleAsleepError,
  VehicleCommandFailedError,
  VehicleChargeCompleteError
} from "../../tesla-client/errors.js";
import type { ChargingConfig } from "../../domain/charging-session.js";
import { App, AppLayer, type TimingConfig } from "../../app.js";
import { AppRuntime } from "../../app-runtime.js";
import { BatteryStateManager } from "../../battery-state-manager.js";
import type { TeslaChargerEvent } from "../../domain/events.js";
import { TeslaChargerEventPubSub } from "../../domain/events.js";
import { ElectricVehicle } from "../../domain/electric-vehicle.js";
import { ChargingSessionLive } from "../../application/charging-session.js";
import { Ampere, KiloWattHours as KWh, StateOfCharge, TimeOfDay } from "../../domain/brands.js";
import { makeBatteryStateManagerTest } from "../fixtures/battery-state-manager.js";
import { makeChargingSpeedControllerTest } from "../fixtures/charging-speed-controller.js";
import { makeDataAdapterTest, type DataAdapterResponse, type DataValues } from "../fixtures/data-adapter.js";
import { makeTeslaClientTest } from "../fixtures/tesla-client.js";

describe("App", () => {
  const defaultChargingConfig: ChargingConfig = {
    waitPerAmereInSeconds: 2,
    extraWaitOnChargeStartInSeconds: 10,
    extraWaitOnChargeStopInSeconds: 10
  };

  const defaultTimingConfig: TimingConfig = {
    syncIntervalInMs: 5000,
    vehicleAwakeningTimeInMs: 10000
  };

  const defaultDataValues: DataValues = {
    voltage: 230,
    current_production: 5000,
    current_load: 0,
    daily_import: 0,
    export_to_grid: 5000,
    import_from_grid: 0,
    battery_power: 0
  };

  const TestElectricVehicle = Layer.effect(
    ElectricVehicle,
    Effect.map(TeslaClient, (teslaClient) => ElectricVehicle.of(teslaClient))
  );

  const makeAppTest = (
    options: {
      timingConfig?: TimingConfig;
      forceChargeToHundredPercent?: boolean;
      latestValues?: ReadonlyArray<DataAdapterResponse>;
      chargingSpeeds?: ReadonlyArray<Ampere>;
      batteryStateManager?: Layer.Layer<BatteryStateManager>;
    } = {}
  ) => {
    const timingConfig = options.timingConfig ?? defaultTimingConfig;
    const tesla = makeTeslaClientTest();
    const dataAdapter = makeDataAdapterTest({ latestValues: options.latestValues ?? [defaultDataValues] });
    const chargingSpeedController = makeChargingSpeedControllerTest(options.chargingSpeeds ?? [Ampere(10)]);
    const batteryStateManager = makeBatteryStateManagerTest();

    const layer = AppLayer({
      chargingConfig: defaultChargingConfig,
      timingConfig,
      forceChargeToHundredPercent: options.forceChargeToHundredPercent ?? false
    }).pipe(
      Layer.provideMerge(
        ChargingSessionLive({
          chargingConfig: defaultChargingConfig,
          watchCadenceInSeconds: 4,
          syncIntervalInMs: timingConfig.syncIntervalInMs,
          vehicleAwakeningTimeInMs: timingConfig.vehicleAwakeningTimeInMs,
          asleepRetryCount: 2,
          abruptRetryCount: 10
        })
      ),
      Layer.provideMerge(TestElectricVehicle),
      Layer.provideMerge(TeslaChargerEventPubSub.layer),
      Layer.provideMerge(AppRuntime.layer),
      Layer.provideMerge(options.batteryStateManager ?? batteryStateManager.layer),
      Layer.provideMerge(chargingSpeedController.layer),
      Layer.provideMerge(tesla.layer),
      Layer.provideMerge(dataAdapter.layer)
    );

    return { layer, tesla: tesla.client, dataAdapter, chargingSpeedController, batteryStateManager };
  };

  const startApp = Effect.gen(function* () {
    const app = yield* App;
    const fiber = yield* Effect.forkChild(app.start());
    yield* Effect.addFinalizer(() => Fiber.interrupt(fiber));
    return { app, fiber };
  });

  it.effect("should authenticate and set up auto-refresh", () => {
    const env = makeAppTest();

    return Effect.gen(function* () {
      yield* startApp;

      // Pass startup sleep (1000ms)
      yield* TestClock.adjust(Duration.seconds(1));

      // Pass sync interval (5s)
      yield* TestClock.adjust(Duration.seconds(6));

      expect(env.tesla.refreshAccessToken).toHaveBeenCalled();
      expect(env.tesla.setupAccessTokenAutoRefreshRecurring).toHaveBeenCalled();
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("should start charging and set ampere when speed > 0", () => {
    const env = makeAppTest();

    return Effect.gen(function* () {
      yield* startApp;

      // Pass startup sleep
      yield* TestClock.adjust(Duration.seconds(1));

      // Pass loop time (Sync 5s + Wait 10s start + Amps wait ~20s) -> 30s is safe
      yield* TestClock.adjust(Duration.seconds(35));

      expect(env.tesla.startCharging).toHaveBeenCalled();
      expect(env.tesla.setAmpere).toHaveBeenCalledWith(Ampere(10));
      expect(env.tesla.wakeUpCar).not.toHaveBeenCalled();
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("should publish ChargingStarted event when start begins", () => {
    const env = makeAppTest();

    return Effect.gen(function* () {
      yield* startApp;

      // Pass startup sleep
      yield* TestClock.adjust(Duration.seconds(1));

      // Pass loop time to trigger setAmpere(10) (0 -> 10)
      yield* TestClock.adjust(Duration.seconds(35));

      expect(env.tesla.setAmpere).toHaveBeenCalledWith(Ampere(10));

      // Verify the ChargingStarted event was published during start
      expect(env.batteryStateManager.events).toHaveLength(1);
      expect(env.batteryStateManager.events[0]).toEqual({
        _tag: "ChargingStarted"
      });
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("should not publish ampere change event when ampere stays the same", () => {
    const env = makeAppTest();

    return Effect.gen(function* () {
      yield* startApp;

      // Pass startup sleep
      yield* TestClock.adjust(Duration.seconds(1));

      // First iteration: 0 -> 10 (publishes event)
      yield* TestClock.adjust(Duration.seconds(35));
      expect(env.tesla.setAmpere).toHaveBeenCalledTimes(1);
      expect(env.batteryStateManager.events).toHaveLength(1);

      // Second iteration: 10 -> 10 (no change, no event)
      yield* TestClock.adjust(Duration.seconds(10));

      expect(env.batteryStateManager.events).toHaveLength(1);
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("should stop charging when speed is too low (< 3)", () => {
    const env = makeAppTest({ chargingSpeeds: [Ampere(10), Ampere(0)] });

    return Effect.gen(function* () {
      yield* startApp;

      // Pass startup
      yield* TestClock.adjust(Duration.seconds(1));

      // Iteration 1 (Start) - 10A. Wait ~30s total.
      yield* TestClock.adjust(Duration.seconds(35));
      expect(env.tesla.startCharging).toHaveBeenCalled();

      // Iteration 2 (Stop) - 0A. Wait ~15s total (extraWaitOnChargeStopInSeconds=10 + sync=5)
      yield* TestClock.adjust(Duration.seconds(20));

      expect(env.tesla.stopCharging).toHaveBeenCalled();
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("should retry on VehicleAsleepError and wake up car", () => {
    const env = makeAppTest();

    return Effect.gen(function* () {
      let setAmpereCalls = 0;
      env.tesla.setAmpere.mockImplementation(() =>
        Effect.suspend(() => {
          setAmpereCalls += 1;
          if (setAmpereCalls === 1) {
            return Effect.fail(new VehicleAsleepError());
          }
          return Effect.void;
        })
      );

      yield* startApp;

      // Pass startup
      yield* TestClock.adjust(Duration.seconds(1));

      // Pass loop
      yield* TestClock.adjust(Duration.seconds(60));

      // We need to advance enough for the retry sleep (vehicleAwakeningTimeInMs = 10000ms)
      yield* TestClock.adjust(Duration.seconds(15));

      expect(env.tesla.wakeUpCar).toHaveBeenCalled();
      expect(env.tesla.setAmpere).toHaveBeenCalledTimes(2); // Failed once, succeded once
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("should handle AbruptProductionDropError by retrying", () => {
    const goodResponse: DataValues = {
      current_production: 5000,
      import_from_grid: 0,
      voltage: 230,
      current_load: 0,
      daily_import: 0,
      export_to_grid: 0,
      battery_power: 0
    };
    const badResponse: DataValues = {
      current_production: 1000,
      import_from_grid: 500,
      daily_import: 200,
      voltage: 230,
      current_load: 0,
      export_to_grid: 0,
      battery_power: 0
    };
    const env = makeAppTest({
      latestValues: [goodResponse],
      chargingSpeeds: [Ampere(6), Ampere(6), Ampere(10), Ampere(8)]
    });

    return Effect.gen(function* () {
      const { fiber } = yield* startApp;

      // Pass startup (1s)
      yield* TestClock.adjust(Duration.seconds(2));

      // Loop 1 (6A). SetAmpere at ~0s, then wait (6-0)*2 + 10 = 22s and sync 5s.
      // Advance a bit to catch the first setAmpere call.
      yield* TestClock.adjust(Duration.seconds(5)); // T=7s. In Wait Phase of Loop 1.

      expect(env.tesla.setAmpere).toHaveBeenCalledTimes(1);
      expect(env.tesla.setAmpere).toHaveBeenLastCalledWith(Ampere(6));

      // Loop 2 (6A): 6 == chargeState.ampere (6), so setAmpere is skipped.
      yield* TestClock.adjust(Duration.seconds(25));

      expect(env.tesla.setAmpere).toHaveBeenCalledTimes(1); // Unchanged
      expect(env.tesla.setAmpere).toHaveBeenLastCalledWith(Ampere(6));

      // Loop 3 (10A): starts at ~32s, setAmpere(10) at ~32s.
      yield* TestClock.adjust(Duration.seconds(2));

      expect(env.tesla.setAmpere).toHaveBeenCalledTimes(2); // +1 Call
      expect(env.tesla.setAmpere).toHaveBeenLastCalledWith(Ampere(10));

      // Grid import during the watch phase triggers AbruptDrop.
      env.dataAdapter.respond(badResponse);
      yield* TestClock.adjust(Duration.seconds(5));

      env.dataAdapter.respond(goodResponse);

      // Advance enough for Loop 4 to process (Retry + New Loop)
      yield* TestClock.adjust(Duration.seconds(10));

      expect(env.chargingSpeedController.calls.length).toBe(4); // 6, 6, 10, 8
      expect(env.tesla.setAmpere).toHaveBeenCalledTimes(3); // 6, 10, 8 (Loop 2 skipped)
      expect(env.tesla.setAmpere).toHaveBeenLastCalledWith(Ampere(8));

      const status = fiber.pollUnsafe();
      expect(status?._tag).not.toBe("Done"); // Still running
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("should stop charging when battery level reaches charge limit", () => {
    const chargingResponse: DataValues = { ...defaultDataValues, current_load: 2300 };
    const env = makeAppTest({
      latestValues: [defaultDataValues, defaultDataValues, chargingResponse]
    });
    env.batteryStateManager.setState({
      batteryLevel: StateOfCharge(80),
      chargeLimitSoc: StateOfCharge(80),
      queriedAtMs: 1715600000000
    });

    return Effect.gen(function* () {
      yield* startApp;

      // Pass startup sleep (1s)
      yield* TestClock.adjust(Duration.seconds(1));

      // First iteration: startCharging + setAmpere(10) + wait (~30s) + sync interval (5s)
      yield* TestClock.adjust(Duration.seconds(40));

      expect(env.tesla.startCharging).toHaveBeenCalled();
      expect(env.tesla.setAmpere).toHaveBeenCalledWith(Ampere(10));

      // Wait a bit more to ensure stop() completes and stopChargingAction() is called
      yield* TestClock.adjust(Duration.seconds(1));

      expect(env.tesla.stopCharging).toHaveBeenCalled();
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("should end the session gracefully when the vehicle reports charging complete on start", () => {
    const env = makeAppTest();
    env.tesla.startCharging.mockReturnValue(
      Effect.fail(
        new VehicleChargeCompleteError({
          message: "Vehicle rejected charging-start because charging is already complete"
        })
      )
    );

    return Effect.gen(function* () {
      const { fiber } = yield* startApp;

      // Pass startup sleep
      yield* TestClock.adjust(Duration.seconds(1));

      // The first sync cycle hits the VehicleChargeComplete rejection, the
      // session ends on its own and app.start() must complete successfully.
      const exit = yield* Fiber.await(fiber);
      expect(exit._tag).toBe("Success");

      // The vehicle never charged, so no stop command is needed.
      expect(env.tesla.stopCharging).not.toHaveBeenCalled();

      const sessionEnded = env.batteryStateManager.events.find((event) => event._tag === "SessionEnded");
      expect(sessionEnded).toBeDefined();
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("should complete shutdown even when the vehicle fails to stop charging", () => {
    const env = makeAppTest();
    // The car finished charging on its own while the app still believes it
    // is charging: every stop attempt is rejected with "not_charging".
    env.tesla.stopCharging.mockReturnValue(
      Effect.fail(
        new VehicleCommandFailedError({
          message: "Command failed. Stderr: car could not execute command: not_charging",
          stderr: "car could not execute command: not_charging"
        })
      )
    );

    // Battery is at its charge limit: the session completes after the first
    // cycle, triggering shutdown while the control state is still "Charging".
    env.batteryStateManager.setState({
      batteryLevel: StateOfCharge(80),
      chargeLimitSoc: StateOfCharge(80),
      queriedAtMs: 0
    });

    return Effect.gen(function* () {
      const { fiber } = yield* startApp;

      // Pass startup sleep
      yield* TestClock.adjust(Duration.seconds(1));

      // First cycle: start + setAmpere + ramp-up watch (~30s) + sync interval (5s)
      yield* TestClock.adjust(Duration.seconds(40));

      // Shutdown must succeed (summary recorded, fibers interrupted) even
      // though the vehicle refuses to stop charging.
      const exit = yield* Fiber.await(fiber);
      expect(exit._tag).toBe("Success");

      expect(env.tesla.stopCharging).toHaveBeenCalled();

      const sessionEnded = env.batteryStateManager.events.find((event) => event._tag === "SessionEnded");
      expect(sessionEnded).toBeDefined();
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("should raise the vehicle charge limit to 100% on startup when enabled", () => {
    const env = makeAppTest({ forceChargeToHundredPercent: true });

    return Effect.gen(function* () {
      yield* startApp;

      // Pass startup sleep
      yield* TestClock.adjust(Duration.seconds(1));

      expect(env.tesla.setChargeLimit).toHaveBeenCalledTimes(1);
      expect(env.tesla.setChargeLimit).toHaveBeenCalledWith(StateOfCharge(100));
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("should not touch the charge limit when it is already 100%", () => {
    const env = makeAppTest({ forceChargeToHundredPercent: true });
    env.tesla.getChargeState.mockReturnValue(
      Effect.succeed({
        batteryLevel: StateOfCharge(100),
        chargeLimitSoc: StateOfCharge(100),
        chargeEnergyAdded: KWh(0)
      })
    );

    return Effect.gen(function* () {
      yield* startApp;

      // Pass startup sleep
      yield* TestClock.adjust(Duration.seconds(1));

      expect(env.tesla.setChargeLimit).not.toHaveBeenCalled();
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("should skip forcing the charge to 100% when charge state is unavailable at startup", () => {
    const env = makeAppTest({ forceChargeToHundredPercent: true });
    env.tesla.getChargeState.mockReturnValue(
      Effect.fail(new ChargeStateQueryFailedError({ message: "vehicle is offline or asleep" }))
    );

    return Effect.gen(function* () {
      yield* startApp;

      // Pass startup sleep
      yield* TestClock.adjust(Duration.seconds(1));

      // Startup is not derailed by the missing charge state.
      expect(env.tesla.setChargeLimit).not.toHaveBeenCalled();
      expect(env.tesla.startCharging).toHaveBeenCalled();
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("should not force the charge to 100% when disabled", () => {
    const env = makeAppTest();

    return Effect.gen(function* () {
      yield* startApp;

      // Pass startup sleep
      yield* TestClock.adjust(Duration.seconds(1));

      expect(env.tesla.setChargeLimit).not.toHaveBeenCalled();
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("should shut down at the configured time of day", () =>
    Effect.gen(function* () {
      const localNow = DateTime.setZone(yield* DateTime.now, DateTime.zoneMakeLocal());
      const { hour, minute } = DateTime.toParts(localNow);
      const shutdownAt = TimeOfDay((hour * 60 + minute + 1) % 1440);
      const env = makeAppTest({ timingConfig: { ...defaultTimingConfig, shutdownAt } });

      yield* Effect.gen(function* () {
        const { fiber } = yield* startApp;

        // Pass startup sleep (1s) and reach the configured shutdown minute.
        yield* TestClock.adjust(Duration.seconds(1));
        yield* TestClock.adjust(Duration.minutes(1));

        const exit = yield* Fiber.await(fiber);
        expect(exit._tag).toBe("Success");
      }).pipe(Effect.provide(env.layer));
    })
  );

  it.effect("should publish SessionEnded with summary when stop() is called", () => {
    const env = makeAppTest({
      latestValues: [
        defaultDataValues,
        defaultDataValues,
        defaultDataValues,
        defaultDataValues,
        defaultDataValues,
        { ...defaultDataValues, daily_import: 2.0 }
      ],
      chargingSpeeds: [Ampere(6), Ampere(10), Ampere(15), Ampere(15)]
    });

    return Effect.gen(function* () {
      // Mock getChargeState for start() and stop()
      let getChargeStateCallCount = 0;
      env.tesla.getChargeState.mockImplementation(() => {
        getChargeStateCallCount++;
        if (getChargeStateCallCount === 1) {
          return Effect.succeed({
            batteryLevel: StateOfCharge(50),
            chargeLimitSoc: StateOfCharge(80),
            chargeEnergyAdded: KWh(0)
          });
        }
        return Effect.succeed({
          batteryLevel: StateOfCharge(60),
          chargeLimitSoc: StateOfCharge(80),
          chargeEnergyAdded: KWh(5.5)
        });
      });

      const { app } = yield* startApp;

      // Pass startup
      yield* TestClock.adjust(Duration.seconds(1));

      // First iteration: setAmpere(6) - 0 -> 6 = 1 fluctuation
      yield* TestClock.adjust(Duration.seconds(30));
      expect(env.tesla.setAmpere).toHaveBeenCalledWith(Ampere(6));

      // Second iteration: setAmpere(10) - 6 -> 10 = 1 fluctuation (total: 2)
      yield* TestClock.adjust(Duration.seconds(30));
      expect(env.tesla.setAmpere).toHaveBeenCalledWith(Ampere(10));

      // Third iteration: setAmpere(15) - 10 -> 15 = 1 fluctuation (total: 3)
      yield* TestClock.adjust(Duration.seconds(30));
      expect(env.tesla.setAmpere).toHaveBeenCalledWith(Ampere(15));

      // Fourth iteration: no change (15 == 15) - should NOT increment fluctuations
      yield* TestClock.adjust(Duration.seconds(10));
      expect(env.tesla.setAmpere).toHaveBeenCalledTimes(3); // Still 3 calls

      yield* app.stop();

      // Verify SessionEnded event was published with expected summary
      const sessionEnded = env.batteryStateManager.events.find(
        (event): event is Extract<TeslaChargerEvent, { _tag: "SessionEnded" }> => event._tag === "SessionEnded"
      );
      expect(sessionEnded).toBeDefined();
      expect(sessionEnded?.summary).toMatchObject({
        sessionDurationMs: expect.any(Number),
        totalEnergyChargedKwh: 5.5, // 5.5 - 0
        gridImportKwh: 2.0, // 2.0 - 0
        solarEnergyUsedKwh: 3.5, // 5.5 - 2.0
        averageChargingSpeedAmps: expect.any(Number),
        ampereFluctuations: 3, // 0->6, 6->10, 10->15 = 3 fluctuations
        gridImportCost: expect.any(Number)
      });
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("should interrupt each session fiber exactly once when stopped", () => {
    const env = makeAppTest();

    return Effect.gen(function* () {
      const tokenRefreshInterrupts = yield* Ref.make(0);
      env.tesla.setupAccessTokenAutoRefreshRecurring.mockReturnValue(
        Effect.never.pipe(Effect.onInterrupt(() => Ref.update(tokenRefreshInterrupts, (n) => n + 1)))
      );

      const { app } = yield* startApp;
      yield* TestClock.adjust(Duration.seconds(1));

      const cyclesBeforeStop = env.chargingSpeedController.calls.length;

      yield* app.stop();
      yield* app.stop();

      expect(env.batteryStateManager.interrupts).toBe(1);
      expect(yield* Ref.get(tokenRefreshInterrupts)).toBe(1);

      // No sync cycle keeps running on the stopped session.
      yield* TestClock.adjust(Duration.minutes(1));
      expect(env.chargingSpeedController.calls.length).toBe(cyclesBeforeStop);
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("should only shut down once when stop() is called twice", () => {
    const env = makeAppTest();

    return Effect.gen(function* () {
      const { app } = yield* startApp;
      yield* TestClock.adjust(Duration.seconds(35));
      expect(env.tesla.startCharging).toHaveBeenCalled();

      yield* app.stop();

      const afterFirstStop = {
        getChargeState: env.tesla.getChargeState.mock.calls.length,
        stopCharging: env.tesla.stopCharging.mock.calls.length,
        sessionEnded: env.batteryStateManager.events.filter((event) => event._tag === "SessionEnded").length
      };
      expect(afterFirstStop.sessionEnded).toBe(1);

      yield* app.stop();

      expect(env.tesla.getChargeState.mock.calls.length).toBe(afterFirstStop.getChargeState);
      expect(env.tesla.stopCharging.mock.calls.length).toBe(afterFirstStop.stopCharging);
      expect(env.batteryStateManager.events.filter((event) => event._tag === "SessionEnded")).toHaveLength(1);
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("should drain SessionEnded to subscribers before stop() returns", () => {
    const receivedEvents: Array<TeslaChargerEvent> = [];
    const env = makeAppTest({
      batteryStateManager: Layer.succeed(BatteryStateManager, {
        start: (pubSub) =>
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(pubSub);
            return yield* Effect.forever(
              PubSub.take(subscription).pipe(
                Effect.flatMap((event) => Effect.yieldNow.pipe(Effect.as(event))),
                Effect.tap((event) =>
                  Effect.sync(() => {
                    receivedEvents.push(event);
                  })
                )
              )
            );
          }).pipe(Effect.scoped),
        get: Effect.succeed(null)
      })
    });

    return Effect.gen(function* () {
      const { app } = yield* startApp;
      yield* TestClock.adjust(Duration.seconds(1));

      yield* app.stop();

      expect(receivedEvents.map((event) => event._tag)).toContain("SessionEnded");
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("should flush SessionEnded published while a subscriber is busy", () =>
    Effect.gen(function* () {
      // No charging events before shutdown: SessionEnded is the only published event.
      const receivedEvents: Array<TeslaChargerEvent> = [];
      const gate = yield* Deferred.make<void>();
      const pubSubReady = yield* Deferred.make<PubSub.PubSub<TeslaChargerEvent>>();

      const env = makeAppTest({
        chargingSpeeds: [Ampere(0)],
        batteryStateManager: Layer.succeed(BatteryStateManager, {
          start: (pubSub) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(pubSubReady, pubSub);
              const subscription = yield* PubSub.subscribe(pubSub);
              yield* Deferred.await(gate);
              return yield* Effect.forever(
                PubSub.take(subscription).pipe(
                  Effect.tap((event) =>
                    Effect.sync(() => {
                      receivedEvents.push(event);
                    })
                  )
                )
              );
            }).pipe(Effect.scoped),
          get: Effect.succeed(null)
        })
      });

      yield* Effect.gen(function* () {
        const { app } = yield* startApp;
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Effect.yieldNow;

        const pubSub = yield* Deferred.await(pubSubReady);
        const stopFiber = yield* Effect.forkChild(app.stop());
        let buffered = yield* PubSub.size(pubSub);
        while (buffered === 0) {
          yield* Effect.yieldNow;
          buffered = yield* PubSub.size(pubSub);
        }
        expect(buffered).toBe(1);

        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(stopFiber);

        expect(receivedEvents.map((event) => event._tag)).toEqual(["SessionEnded"]);
      }).pipe(Effect.provide(env.layer));
    })
  );
});
