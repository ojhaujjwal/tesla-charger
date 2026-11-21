import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ExcessSolarNonAggresiveControllerLayer } from "../../../charging-speed-controller/excess-solar-non-aggresive.controller.js";
import { ChargingSpeedController } from "../../../charging-speed-controller/types.js";
import { DynamicChargingConfig } from "../../../charging-speed-controller/dynamic-config.js";
import { Ampere, Watt } from "../../../domain/brands.js";
import {
  makeChargingSpeedControllerTest,
  type ChargingSpeedControllerTest
} from "../../fixtures/charging-speed-controller.js";
import { makeDataAdapterTest, type DataAdapterResponse, type DataAdapterTest } from "../../fixtures/data-adapter.js";

const fresh = (read: number): DataAdapterResponse => ({
  export_to_grid: read * 100,
  current_production: read * 1000,
  current_load: 500,
  voltage: 240
});

const stale = (exportToGrid: number, currentProduction = 2000, currentLoad = 500): DataAdapterResponse => ({
  export_to_grid: exportToGrid,
  current_production: currentProduction,
  current_load: currentLoad,
  voltage: 240
});

describe("ExcessSolarNonAggresiveController", () => {
  const TestLayer = (dataAdapter: DataAdapterTest, base: ChargingSpeedControllerTest, requiredConsistentReads = 3) =>
    ExcessSolarNonAggresiveControllerLayer({
      baseControllerLayer: base.layer,
      requiredConsistentReads
    }).pipe(
      Layer.provideMerge(dataAdapter.layer),
      Layer.provideMerge(
        Layer.succeed(DynamicChargingConfig, {
          getBufferPower: Effect.succeed(Watt(100)),
          setBufferPower: () => Effect.void
        })
      )
    );

  it.effect("should return 0 initially when first reading is 0", () => {
    const dataAdapter = makeDataAdapterTest({ latestValues: [fresh(1)] });
    const base = makeChargingSpeedControllerTest([Ampere(0)]);

    return Effect.gen(function* () {
      const controller = yield* ChargingSpeedController;
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(0));
    }).pipe(Effect.provide(TestLayer(dataAdapter, base)));
  });

  it.effect("should immediately decrease when solar drops", () => {
    const dataAdapter = makeDataAdapterTest({
      latestValues: [fresh(1), fresh(2), fresh(3), stale(300, 3000, 500)]
    });
    const base = makeChargingSpeedControllerTest([Ampere(15), Ampere(15), Ampere(15), Ampere(8)]);

    return Effect.gen(function* () {
      const controller = yield* ChargingSpeedController;
      yield* controller.determineChargingSpeed(Ampere(0));
      yield* controller.determineChargingSpeed(Ampere(0));

      const result1 = yield* controller.determineChargingSpeed(Ampere(0));
      expect(result1).toBe(Ampere(15));

      const result2 = yield* controller.determineChargingSpeed(Ampere(15));
      expect(result2).toBe(Ampere(8));
    }).pipe(Effect.provide(TestLayer(dataAdapter, base)));
  });

  it.effect("should immediately start on first fresh reading but require consistency for further increases", () => {
    const dataAdapter = makeDataAdapterTest({
      latestValues: [fresh(1), fresh(2), fresh(3), fresh(4)]
    });
    const base = makeChargingSpeedControllerTest([Ampere(10), Ampere(20), Ampere(20), Ampere(20)]);

    return Effect.gen(function* () {
      const controller = yield* ChargingSpeedController;
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(10));
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(10));
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(10));
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(20));
    }).pipe(Effect.provide(TestLayer(dataAdapter, base)));
  });

  it.effect("should NOT count stale data as additional readings", () => {
    const dataAdapter = makeDataAdapterTest({
      latestValues: [
        stale(1000, 2000, 500),
        stale(1000, 2000, 500),
        stale(1000, 2000, 500),
        stale(2000, 2000, 500),
        stale(3000, 2000, 500)
      ]
    });
    const base = makeChargingSpeedControllerTest([Ampere(10), Ampere(10), Ampere(10), Ampere(10), Ampere(10)]);

    return Effect.gen(function* () {
      const controller = yield* ChargingSpeedController;
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(10));
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(10));
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(10));
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(10));
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(10));
    }).pipe(Effect.provide(TestLayer(dataAdapter, base)));
  });

  it.effect("should not increase if readings fluctuate", () => {
    const dataAdapter = makeDataAdapterTest({ latestValues: [fresh(1), fresh(2), fresh(3)] });
    const base = makeChargingSpeedControllerTest([Ampere(15), Ampere(20), Ampere(25)]);

    return Effect.gen(function* () {
      const controller = yield* ChargingSpeedController;
      const result1 = yield* controller.determineChargingSpeed(Ampere(0));
      expect(result1).toBe(Ampere(15));

      const result2 = yield* controller.determineChargingSpeed(Ampere(0));
      expect(result2).toBe(Ampere(15));

      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(15));
    }).pipe(Effect.provide(TestLayer(dataAdapter, base)));
  });

  it.effect("should increase when all fresh readings support the new speed", () => {
    const dataAdapter = makeDataAdapterTest({
      latestValues: [fresh(1), fresh(2), fresh(3), fresh(4), fresh(5), fresh(6)]
    });
    const base = makeChargingSpeedControllerTest([
      Ampere(20),
      Ampere(20),
      Ampere(20),
      Ampere(25),
      Ampere(25),
      Ampere(25)
    ]);

    return Effect.gen(function* () {
      const controller = yield* ChargingSpeedController;
      yield* controller.determineChargingSpeed(Ampere(0));
      yield* controller.determineChargingSpeed(Ampere(0));

      const result = yield* controller.determineChargingSpeed(Ampere(0));
      expect(result).toBe(Ampere(20));

      expect(yield* controller.determineChargingSpeed(Ampere(20))).toBe(Ampere(20));
      expect(yield* controller.determineChargingSpeed(Ampere(20))).toBe(Ampere(20));
      expect(yield* controller.determineChargingSpeed(Ampere(20))).toBe(Ampere(25));
    }).pipe(Effect.provide(TestLayer(dataAdapter, base)));
  });
});
