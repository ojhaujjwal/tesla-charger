import { describe, it, expect, beforeEach } from "@effect/vitest";
import { vi } from "vitest";
import { type MockedObject } from "vitest";
import { ExcessSolarNonAggresiveControllerLayer } from "../../../charging-speed-controller/excess-solar-non-aggresive.controller.js";
import { Effect, Layer } from "effect";
import { ChargingSpeedController } from "../../../charging-speed-controller/types.js";
import { DynamicChargingConfig } from "../../../charging-speed-controller/dynamic-config.js";
import { DataAdapter, type IDataAdapter } from "../../../data-adapter/types.js";
import { Ampere } from "../../../domain/brands.js";

describe("ExcessSolarNonAggresiveController", () => {
  let mockBaseController: {
    determineChargingSpeed: MockedObject<ChargingSpeedController["Service"]>["determineChargingSpeed"];
  };
  let mockDataAdapter: MockedObject<IDataAdapter>;

  // Helper to create mock data adapter response with unique values to simulate fresh data
  let dataCounter = 0;
  const freshData = () => {
    dataCounter++;
    return Effect.succeed({
      export_to_grid: dataCounter * 100,
      current_production: dataCounter * 1000,
      current_load: 500,
      voltage: 240,
      daily_import: 0,
      import_from_grid: 0,
      battery_power: 0
    });
  };

  const staleData = (exportToGrid: number, currentProduction = 2000, currentLoad = 500) => {
    return Effect.succeed({
      export_to_grid: exportToGrid,
      current_production: currentProduction,
      current_load: currentLoad,
      voltage: 240,
      daily_import: 0,
      import_from_grid: 0,
      battery_power: 0
    });
  };

  beforeEach(() => {
    dataCounter = 0;
    mockBaseController = {
      determineChargingSpeed: vi.fn()
    };

    mockDataAdapter = {
      queryLatestValues: vi.fn(),
      getLowestValueInLastXMinutes: vi.fn()
    };
  });

  const getTestLayer = (requiredConsistentReads = 3) => {
    const baseControllerLayer = Layer.succeed(ChargingSpeedController, ChargingSpeedController.of(mockBaseController));

    return ExcessSolarNonAggresiveControllerLayer({
      baseControllerLayer,
      requiredConsistentReads
    }).pipe(
      Layer.provideMerge(Layer.succeed(DataAdapter, mockDataAdapter)),
      Layer.provideMerge(
        Layer.succeed(DynamicChargingConfig, {
          getBufferPower: Effect.succeed(100),
          setBufferPower: () => Effect.void
        })
      )
    );
  };

  it.effect("should return 0 initially when first reading is 0", () =>
    Effect.gen(function* () {
      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(0)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());

      const controller = yield* ChargingSpeedController;
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(0));
    }).pipe(Effect.provide(getTestLayer()))
  );

  it.effect("should immediately decrease when solar drops", () =>
    Effect.gen(function* () {
      // Build up to speed 15 with 3 fresh readings
      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(15)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());

      const controller = yield* ChargingSpeedController;
      yield* controller.determineChargingSpeed(Ampere(0));

      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(15)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
      yield* controller.determineChargingSpeed(Ampere(0));

      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(15)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
      const result1 = yield* controller.determineChargingSpeed(Ampere(0));
      expect(result1).toBe(Ampere(15));

      // Now solar drops - should immediately decrease (even with stale data)
      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(8)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(staleData(300, 3000, 500)); // same as last (last fresh was counter 3: 300, 3000, 500)
      const result2 = yield* controller.determineChargingSpeed(Ampere(15));
      expect(result2).toBe(Ampere(8));
    }).pipe(Effect.provide(getTestLayer()))
  );

  it.effect("should immediately start on first fresh reading but require consistency for further increases", () =>
    Effect.gen(function* () {
      // First fresh reading: 10 - should be applied immediately (startup)
      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(10)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());

      const controller = yield* ChargingSpeedController;
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(10));

      // Second fresh reading: 20 - should NOT increase yet (need consistency)
      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(20)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(10));

      // Third fresh reading: 20 - still holding
      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(20)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(10));

      // Fourth fresh reading: 20 - now we have 3 consistent readings of 20 (history: [20, 20, 20] effectively or at least consistent enough)
      // Wait, history window is 3.
      // 1: [10] -> 10 applied.
      // 2: [10, 20] -> 10 applied.
      // 3: [10, 20, 20] -> 10 applied.
      // 4: [20, 20, 20] -> 20 applied.
      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(20)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(20));
    }).pipe(Effect.provide(getTestLayer()))
  );

  it.effect("should NOT count stale data as additional readings", () =>
    Effect.gen(function* () {
      // First fresh reading: 10 - applied immediately now
      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(10)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(staleData(1000, 2000, 500));

      const controller = yield* ChargingSpeedController;
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(10));

      // Stale reading (same data) - should NOT add to history, so defaults to lastApplied (10)
      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(10)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(staleData(1000, 2000, 500)); // same!
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(10));

      // Another stale reading - still NOT added
      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(10)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(staleData(1000, 2000, 500)); // same!
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(10));

      // Now fresh data - second reading (let's say 15 to test it doesn't jump)
      // If we keep 10, it stays 10.
      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(10)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(staleData(2000, 2000, 500)); // different!
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(10));

      // Third fresh reading - still 10
      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(10)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(staleData(3000, 2000, 500)); // different!
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(10));
    }).pipe(Effect.provide(getTestLayer()))
  );

  it.effect("should not increase if readings fluctuate", () =>
    Effect.gen(function* () {
      // Reading 1: 15 - Applied immediately
      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(15)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());

      const controller = yield* ChargingSpeedController;
      const result1 = yield* controller.determineChargingSpeed(Ampere(0));
      expect(result1).toBe(Ampere(15));

      // Reading 2: 20 - Rejected (inconsistent)
      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(20)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
      const result2 = yield* controller.determineChargingSpeed(Ampere(0));
      expect(result2).toBe(Ampere(15));

      // Reading 3: 25 - rejected (history is [15, 20, 25])
      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(25)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(15));
    }).pipe(Effect.provide(getTestLayer()))
  );

  it.effect("should increase when all fresh readings support the new speed", () =>
    Effect.gen(function* () {
      // Build consistent readings
      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(20)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());

      const controller = yield* ChargingSpeedController;
      yield* controller.determineChargingSpeed(Ampere(0));

      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(20)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
      yield* controller.determineChargingSpeed(Ampere(0));

      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(20)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
      const result = yield* controller.determineChargingSpeed(Ampere(0));
      expect(result).toBe(Ampere(20));

      // Now try to increase to 25 - need 3 more fresh readings
      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(25)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
      expect(yield* controller.determineChargingSpeed(Ampere(20))).toBe(Ampere(20)); // Still at 20

      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(25)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
      expect(yield* controller.determineChargingSpeed(Ampere(20))).toBe(Ampere(20)); // Still at 20

      mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(Ampere(25)));
      mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
      expect(yield* controller.determineChargingSpeed(Ampere(20))).toBe(Ampere(25)); // Now increase to 25
    }).pipe(Effect.provide(getTestLayer()))
  );
});
