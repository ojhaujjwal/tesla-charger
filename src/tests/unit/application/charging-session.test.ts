import { describe, expect, it } from "@effect/vitest";
import { Cause, Duration, Effect, Exit, Fiber, Layer, Option } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { ChargingSessionLive } from "../../../application/charging-session.js";
import {
  ChargingSession,
  createInitialChargingControlState,
  createInitialChargingSessionStats,
  type CycleResult
} from "../../../domain/charging-session.js";
import { ElectricVehicle } from "../../../domain/electric-vehicle.js";
import { TeslaChargerEventPubSub } from "../../../domain/events.js";
import { Ampere } from "../../../domain/brands.js";
import type { CycleError } from "../../../domain/charging-session.js";
import { makeBatteryStateManagerTest } from "../../fixtures/battery-state-manager.js";
import { makeChargingSpeedControllerTest } from "../../fixtures/charging-speed-controller.js";
import { makeDataAdapterTest, type DataValues } from "../../fixtures/data-adapter.js";

const chargingConfig = {
  waitPerAmereInSeconds: 2,
  extraWaitOnChargeStartInSeconds: 10,
  extraWaitOnChargeStopInSeconds: 10
};

const solarOnly: DataValues = {
  voltage: 230,
  current_production: 5000,
  current_load: 0,
  daily_import: 0,
  export_to_grid: 5000,
  import_from_grid: 0,
  battery_power: 0
};

const importingFromGrid: DataValues = {
  ...solarOnly,
  current_production: 1000,
  import_from_grid: 500,
  export_to_grid: 0
};

const makeSessionTest = (options: { readonly abruptRetryCount?: number } = {}) => {
  const dataAdapter = makeDataAdapterTest({ latestValues: [solarOnly] });
  const chargingSpeedController = makeChargingSpeedControllerTest([Ampere(10)]);
  const batteryStateManager = makeBatteryStateManagerTest();
  const vehicleCalls = { startCharging: 0, setAmpere: 0, stopCharging: 0 };

  const electricVehicle = Layer.succeed(
    ElectricVehicle,
    ElectricVehicle.of({
      startCharging: () =>
        Effect.sync(() => {
          vehicleCalls.startCharging += 1;
        }),
      stopCharging: () =>
        Effect.sync(() => {
          vehicleCalls.stopCharging += 1;
        }),
      setAmpere: () =>
        Effect.sync(() => {
          vehicleCalls.setAmpere += 1;
        }),
      wakeUpCar: () => Effect.void
    })
  );

  const layer = ChargingSessionLive({
    chargingConfig,
    watchCadenceInSeconds: 4,
    syncIntervalInMs: 5000,
    vehicleAwakeningTimeInMs: 10000,
    asleepRetryCount: 2,
    abruptRetryCount: options.abruptRetryCount ?? 0
  }).pipe(
    Layer.provideMerge(electricVehicle),
    Layer.provideMerge(TeslaChargerEventPubSub.layer),
    Layer.provideMerge(batteryStateManager.layer),
    Layer.provideMerge(chargingSpeedController.layer),
    Layer.provideMerge(dataAdapter.layer)
  );

  return { layer, dataAdapter, vehicleCalls };
};

const typedError = (exit: Exit.Exit<CycleResult, CycleError>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) throw new Error("expected a failure exit");
  const error = Cause.findErrorOption(exit.cause);
  expect(Option.isSome(error)).toBe(true);
  if (Option.isNone(error)) throw new Error("expected a typed failure");
  return error.value;
};

describe("ChargingSession ramp-up watch", () => {
  it.effect("should fail when the grid import appears mid-window", () => {
    const env = makeSessionTest();

    return Effect.gen(function* () {
      const session = yield* ChargingSession;
      const fiber = yield* Effect.forkChild(
        session.runCycle(createInitialChargingControlState(), createInitialChargingSessionStats())
      );

      // The first poll (t=0) sees export; the next poll is at the 4 s cadence.
      yield* TestClock.adjust(Duration.seconds(1));
      env.dataAdapter.respond(importingFromGrid);

      // Covers the cadence poll at t=4 s and, on the buggy path, the rest of
      // the 30 s ramp window plus the sync interval.
      yield* TestClock.adjust(Duration.seconds(40));

      const error = typedError(yield* Fiber.await(fiber));
      expect(error._tag).toBe("GridImportExhausted");
      if (error._tag === "GridImportExhausted") {
        expect(error.initialProduction).toBe(5000);
        expect(error.currentProduction).toBe(1000);
      }
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("should retry the cycle for each configured abrupt-drop retry before failing", () => {
    const env = makeSessionTest({ abruptRetryCount: 2 });

    return Effect.gen(function* () {
      const session = yield* ChargingSession;
      const fiber = yield* Effect.forkChild(
        session.runCycle(createInitialChargingControlState(), createInitialChargingSessionStats())
      );

      yield* TestClock.adjust(Duration.seconds(1));
      env.dataAdapter.respond(importingFromGrid);
      yield* TestClock.adjust(Duration.seconds(40));

      const error = typedError(yield* Fiber.await(fiber));
      expect(error._tag).toBe("GridImportExhausted");
      expect(env.vehicleCalls.startCharging).toBe(3);
      expect(env.vehicleCalls.setAmpere).toBe(3);
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("should succeed when the window elapses without grid import", () => {
    const env = makeSessionTest();

    return Effect.gen(function* () {
      const session = yield* ChargingSession;
      const fiber = yield* Effect.forkChild(
        session.runCycle(createInitialChargingControlState(), createInitialChargingSessionStats())
      );

      yield* TestClock.adjust(Duration.seconds(5));
      expect(fiber.pollUnsafe()?._tag).not.toBe("Done");

      yield* TestClock.adjust(Duration.seconds(30));

      const exit = yield* Fiber.await(fiber);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.state).toEqual({ status: "Charging", ampere: Ampere(10) });
        expect(exit.value.outcome).toEqual({ status: "Running" });
      }
    }).pipe(Effect.provide(env.layer));
  });
});
