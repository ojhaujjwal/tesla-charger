import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ExcessSolarAggresiveControllerLayer } from "../../../charging-speed-controller/excess-solar-aggresive-controller.js";
import { DynamicChargingConfig } from "../../../charging-speed-controller/dynamic-config.js";
import {
  ChargingSpeedController,
  InadequateDataToDetermineSpeedError
} from "../../../charging-speed-controller/types.js";
import { SourceNotAvailableError } from "../../../data-adapter/types.js";
import { Ampere, Watt } from "../../../domain/brands.js";
import { makeDataAdapterTest, type DataAdapterTest } from "../../fixtures/data-adapter.js";

describe("ExcessSolarAggresiveController", () => {
  const TestLayer = (
    dataAdapter: DataAdapterTest,
    config: { bufferPower: Watt; multipleOf: number } = { bufferPower: Watt(100), multipleOf: 5 }
  ) =>
    ExcessSolarAggresiveControllerLayer({ multipleOf: config.multipleOf }).pipe(
      Layer.provideMerge(
        Layer.succeed(DynamicChargingConfig, {
          getBufferPower: Effect.succeed(config.bufferPower),
          setBufferPower: () => Effect.void
        })
      ),
      Layer.provideMerge(dataAdapter.layer)
    );

  describe("determineChargingSpeed", () => {
    it.effect("should limit charging speed to 32A", () => {
      const dataAdapter = makeDataAdapterTest({
        latestValues: [{ voltage: 230, battery_power: 0, export_to_grid: 10000, import_from_grid: 0 }]
      });

      return Effect.gen(function* () {
        const controller = yield* ChargingSpeedController;
        const chargingSpeed = yield* controller.determineChargingSpeed(Ampere(0));
        expect(chargingSpeed).toBe(Ampere(32));
      }).pipe(Effect.provide(TestLayer(dataAdapter)));
    });

    it.effect("should round charging speed to nearest multiple of 5", () => {
      const dataAdapter = makeDataAdapterTest({
        latestValues: [{ voltage: 230, battery_power: 0, export_to_grid: 2000, import_from_grid: 0 }]
      });

      return Effect.gen(function* () {
        const controller = yield* ChargingSpeedController;
        const chargingSpeed = yield* controller.determineChargingSpeed(Ampere(10));
        expect(chargingSpeed).toBeGreaterThan(0);
        expect(chargingSpeed % 5).toBe(Ampere(0));
      }).pipe(Effect.provide(TestLayer(dataAdapter)));
    });

    it.effect("should return 0 when no excess solar is available after buffer", () => {
      const dataAdapter = makeDataAdapterTest({
        latestValues: [{ voltage: 230, battery_power: 0, export_to_grid: 50, import_from_grid: 0 }]
      });

      return Effect.gen(function* () {
        const controller = yield* ChargingSpeedController;
        const chargingSpeed = yield* controller.determineChargingSpeed(Ampere(0));
        expect(chargingSpeed).toBe(Ampere(0));
      }).pipe(Effect.provide(TestLayer(dataAdapter)));
    });

    it.effect("should return 0 when importing from grid", () => {
      const dataAdapter = makeDataAdapterTest({
        latestValues: [{ voltage: 230, battery_power: 0, export_to_grid: 0, import_from_grid: 1230 }]
      });

      return Effect.gen(function* () {
        const controller = yield* ChargingSpeedController;
        const chargingSpeed = yield* controller.determineChargingSpeed(Ampere(0));
        expect(chargingSpeed).toBe(Ampere(0));
      }).pipe(Effect.provide(TestLayer(dataAdapter)));
    });

    it.effect.each([
      [1800, 5],
      [4600, 15],
      [4700, 20],
      [4800, 20]
    ])("should calculate excess solar correctly with current charging speed", ([exportingToGrid, chargingSpeed]) => {
      const dataAdapter = makeDataAdapterTest({
        latestValues: [{ voltage: 230, battery_power: 0, export_to_grid: exportingToGrid, import_from_grid: 0 }]
      });

      return Effect.gen(function* () {
        const controller = yield* ChargingSpeedController;
        const resultingChargingSpeed = yield* controller.determineChargingSpeed(Ampere(10));
        expect(resultingChargingSpeed).toEqual(Ampere(10 + chargingSpeed));
      }).pipe(Effect.provide(TestLayer(dataAdapter)));
    });

    it.effect("should include battery charging power in excess calculation when battery is charging", () => {
      const dataAdapter = makeDataAdapterTest({
        latestValues: [{ voltage: 230, battery_power: -1650, export_to_grid: 0, import_from_grid: 0 }]
      });

      return Effect.gen(function* () {
        const controller = yield* ChargingSpeedController;
        const chargingSpeed = yield* controller.determineChargingSpeed(Ampere(0));
        expect(chargingSpeed).toBe(Ampere(5));
      }).pipe(Effect.provide(TestLayer(dataAdapter, { bufferPower: Watt(100), multipleOf: 5 })));
    });

    it.effect("should combine battery charging power and grid export for total excess", () => {
      const dataAdapter = makeDataAdapterTest({
        latestValues: [{ voltage: 230, battery_power: -1650, export_to_grid: 1000, import_from_grid: 0 }]
      });

      return Effect.gen(function* () {
        const controller = yield* ChargingSpeedController;
        const chargingSpeed = yield* controller.determineChargingSpeed(Ampere(0));
        expect(chargingSpeed).toBe(Ampere(10));
      }).pipe(Effect.provide(TestLayer(dataAdapter, { bufferPower: Watt(100), multipleOf: 5 })));
    });

    it.effect("should use only grid export when battery is not charging (discharging)", () => {
      const dataAdapter = makeDataAdapterTest({
        latestValues: [{ voltage: 230, battery_power: 500, export_to_grid: 2000, import_from_grid: 0 }]
      });

      return Effect.gen(function* () {
        const controller = yield* ChargingSpeedController;
        const chargingSpeed = yield* controller.determineChargingSpeed(Ampere(0));
        expect(chargingSpeed).toBe(Ampere(5));
      }).pipe(Effect.provide(TestLayer(dataAdapter, { bufferPower: Watt(100), multipleOf: 5 })));
    });

    it.effect("should subtract battery discharge when demand exceeds solar production", () => {
      const dataAdapter = makeDataAdapterTest({
        latestValues: [{ voltage: 230, battery_power: 2000, export_to_grid: 0, import_from_grid: 500 }]
      });

      return Effect.gen(function* () {
        const controller = yield* ChargingSpeedController;
        const chargingSpeed = yield* controller.determineChargingSpeed(Ampere(0));
        expect(chargingSpeed).toBe(Ampere(0));
      }).pipe(Effect.provide(TestLayer(dataAdapter, { bufferPower: Watt(100), multipleOf: 5 })));
    });

    it.effect("should correctly calculate excess when battery discharges with solar surplus", () => {
      const dataAdapter = makeDataAdapterTest({
        latestValues: [{ voltage: 230, battery_power: 1000, export_to_grid: 1500, import_from_grid: 0 }]
      });

      return Effect.gen(function* () {
        const controller = yield* ChargingSpeedController;
        const chargingSpeed = yield* controller.determineChargingSpeed(Ampere(0));
        expect(chargingSpeed).toBe(Ampere(0));
      }).pipe(Effect.provide(TestLayer(dataAdapter, { bufferPower: Watt(100), multipleOf: 5 })));
    });

    it.effect("should fail with InadequateDataToDetermineSpeedError when the data source is unavailable", () => {
      const dataAdapter = makeDataAdapterTest({
        latestValues: [{ failure: new SourceNotAvailableError() }]
      });

      return Effect.gen(function* () {
        const controller = yield* ChargingSpeedController;
        const error = yield* Effect.flip(controller.determineChargingSpeed(Ampere(0)));
        expect(error).toBeInstanceOf(InadequateDataToDetermineSpeedError);
      }).pipe(Effect.provide(TestLayer(dataAdapter)));
    });
  });
});
