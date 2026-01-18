import { describe, it, expect, beforeEach } from "@effect/vitest";
import { vi } from "vitest";
import { type MockedObject } from "vitest";
import { ExcessSolarNonAggresiveControllerLayer } from '../../../charging-speed-controller/excess-solar-non-aggresive.controller.js';
import { Effect, Layer } from "effect";
import { ChargingSpeedController } from '../../../charging-speed-controller/types.js';
import { DataAdapter, type IDataAdapter } from '../../../data-adapter/types.js';

describe('ExcessSolarNonAggresiveController', () => {
  let mockBaseController: { determineChargingSpeed: MockedObject<ChargingSpeedController['Type']>['determineChargingSpeed'] };
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
      import_from_grid: 0
    });
  };

  const staleData = (exportToGrid: number, currentProduction = 2000, currentLoad = 500) => {
    return Effect.succeed({
      export_to_grid: exportToGrid,
      current_production: currentProduction,
      current_load: currentLoad,
      voltage: 240,
      daily_import: 0,
      import_from_grid: 0
    });
  };

  beforeEach(() => {
    dataCounter = 0;
    mockBaseController = {
      determineChargingSpeed: vi.fn(),
    };

    mockDataAdapter = {
      queryLatestValues: vi.fn(),
      getLowestValueInLastXMinutes: vi.fn(),
    };
  });

  const getTestLayer = (requiredConsistentReads = 3) => {
    const baseControllerLayer = Layer.succeed(
      ChargingSpeedController,
      ChargingSpeedController.of(mockBaseController)
    );

    return ExcessSolarNonAggresiveControllerLayer({
      baseControllerLayer,
      requiredConsistentReads
    }).pipe(
      Layer.provideMerge(Layer.succeed(DataAdapter, mockDataAdapter))
    );
  };

  it.effect('should return 0 initially when first reading is 0', () => Effect.gen(function* () {
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(0));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());

    const controller = yield* ChargingSpeedController;
    expect((yield* controller.determineChargingSpeed(0))).toBe(0);
  }).pipe(Effect.provide(getTestLayer())));

  it.effect('should immediately decrease when solar drops', () => Effect.gen(function* () {
    // Build up to speed 15 with 3 fresh readings
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(15));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());

    const controller = yield* ChargingSpeedController;
    yield* controller.determineChargingSpeed(0);

    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(15));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
    yield* controller.determineChargingSpeed(0);

    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(15));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
    const result1 = yield* controller.determineChargingSpeed(0);
    expect(result1).toBe(15);

    // Now solar drops - should immediately decrease (even with stale data)
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(8));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(staleData(300, 3000, 500)); // same as last (last fresh was counter 3: 300, 3000, 500)
    const result2 = yield* controller.determineChargingSpeed(15);
    expect(result2).toBe(8);
  }).pipe(Effect.provide(getTestLayer())));

  it.effect('should only increase after 3 consistent FRESH readings', () => Effect.gen(function* () {
    // First fresh reading: 10 - not enough history yet
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(10));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());

    const controller = yield* ChargingSpeedController;
    expect((yield* controller.determineChargingSpeed(0))).toBe(0);

    // Second fresh reading: 10 - still not enough
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(10));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
    expect((yield* controller.determineChargingSpeed(0))).toBe(0);

    // Third fresh reading: 10 - now we have 3 consistent readings, should increase
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(10));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
    expect((yield* controller.determineChargingSpeed(0))).toBe(10);
  }).pipe(Effect.provide(getTestLayer())));

  it.effect('should NOT count stale data as additional readings', () => Effect.gen(function* () {
    // First fresh reading: 10
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(10));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(staleData(1000, 2000, 500));

    const controller = yield* ChargingSpeedController;
    expect((yield* controller.determineChargingSpeed(0))).toBe(0);

    // Stale reading (same data) - should NOT add to history
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(10));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(staleData(1000, 2000, 500)); // same!
    expect((yield* controller.determineChargingSpeed(0))).toBe(0);

    // Another stale reading - still NOT added
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(10));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(staleData(1000, 2000, 500)); // same!
    expect((yield* controller.determineChargingSpeed(0))).toBe(0); // still 0, not 10!

    // Now fresh data - second reading
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(10));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(staleData(2000, 2000, 500)); // different!
    expect((yield* controller.determineChargingSpeed(0))).toBe(0); // still only 2 fresh reads

    // Third fresh reading - NOW should increase
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(10));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(staleData(3000, 2000, 500)); // different!
    expect((yield* controller.determineChargingSpeed(0))).toBe(10);
  }).pipe(Effect.provide(getTestLayer())));

  it.effect('should not increase if readings fluctuate', () => Effect.gen(function* () {
    // Reading 1: 15
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(15));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());

    const controller = yield* ChargingSpeedController;
    yield* controller.determineChargingSpeed(0);

    // Reading 2: 20
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(20));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
    yield* controller.determineChargingSpeed(0);

    // Reading 3: 25 - history is [15, 20, 25], but not all >= 25
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(25));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
    expect((yield* controller.determineChargingSpeed(0))).toBe(0);
  }).pipe(Effect.provide(getTestLayer())));

  it.effect('should increase when all fresh readings support the new speed', () => Effect.gen(function* () {
    // Build consistent readings
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(20));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());

    const controller = yield* ChargingSpeedController;
    yield* controller.determineChargingSpeed(0);

    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(20));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
    yield* controller.determineChargingSpeed(0);

    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(20));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
    const result = yield* controller.determineChargingSpeed(0);
    expect(result).toBe(20);

    // Now try to increase to 25 - need 3 more fresh readings
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(25));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
    expect((yield* controller.determineChargingSpeed(20))).toBe(20); // Still at 20

    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(25));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
    expect((yield* controller.determineChargingSpeed(20))).toBe(20); // Still at 20

    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(25));
    mockDataAdapter.queryLatestValues.mockReturnValueOnce(freshData());
    expect((yield* controller.determineChargingSpeed(20))).toBe(25); // Now increase to 25
  }).pipe(Effect.provide(getTestLayer())));
});
