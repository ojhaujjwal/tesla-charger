import { describe, it, expect, beforeEach } from "@effect/vitest";
import { vi } from "vitest";
import { type MockedObject } from "vitest";
import { ExcessSolarAggresiveControllerLayer } from "../../../charging-speed-controller/excess-solar-aggresive-controller.js";
import { DataAdapter, type IDataAdapter } from "../../../data-adapter/types.js";
import { Effect, Layer } from "effect";
import { ChargingSpeedController } from "../../../charging-speed-controller/types.js";

describe("ExcessSolarAggresiveController", () => {
  let mockDataAdapter: MockedObject<IDataAdapter>;

  beforeEach(() => {
    mockDataAdapter = {
      queryLatestValues: vi.fn(),
      getLowestValueInLastXMinutes: vi.fn()
    };
  });

  const TestLayer = (config: { bufferPower: number; multipleOf: number } = { bufferPower: 100, multipleOf: 5 }) =>
    ExcessSolarAggresiveControllerLayer(config).pipe(Layer.provideMerge(Layer.succeed(DataAdapter, mockDataAdapter)));

  describe("determineChargingSpeed", () => {
    it.effect("should limit charging speed to 32A", () =>
      Effect.gen(function* () {
        // Mock data to simulate high excess solar
        mockDataAdapter.queryLatestValues.mockReturnValue(
          Effect.succeed({
            voltage: 230,
            current_production: 0,
            current_load: 0,
            daily_import: 0,
            export_to_grid: 10000,
            import_from_grid: 0,
            battery_power: 0
          })
        );

        const controller = yield* ChargingSpeedController;
        const chargingSpeed = yield* controller.determineChargingSpeed(0);
        expect(chargingSpeed).toBe(32);
      }).pipe(Effect.provide(TestLayer()))
    );

    it.effect("should round charging speed to nearest multiple of 5", () =>
      Effect.gen(function* () {
        // Mock data to simulate moderate excess solar
        mockDataAdapter.queryLatestValues.mockReturnValue(
          Effect.succeed({
            voltage: 230,
            current_production: 0,
            current_load: 0,
            daily_import: 0,
            export_to_grid: 2000,
            import_from_grid: 0,
            battery_power: 0
          })
        );

        const controller = yield* ChargingSpeedController;
        const chargingSpeed = yield* controller.determineChargingSpeed(10);
        expect(chargingSpeed).toBeGreaterThan(0);
        expect(chargingSpeed % 5).toBe(0);
      }).pipe(Effect.provide(TestLayer()))
    );

    it.effect("should return 0 when no excess solar is available after buffer", () =>
      Effect.gen(function* () {
        // Mock data to simulate minimal excess solar
        mockDataAdapter.queryLatestValues.mockReturnValue(
          Effect.succeed({
            voltage: 230,
            current_production: 0,
            current_load: 0,
            daily_import: 0,
            export_to_grid: 50,
            import_from_grid: 0,
            battery_power: 0
          })
        );

        const controller = yield* ChargingSpeedController;
        const chargingSpeed = yield* controller.determineChargingSpeed(0);
        expect(chargingSpeed).toBe(0);
      }).pipe(Effect.provide(TestLayer()))
    );

    it.effect("should return 0 when importing from grid", () =>
      Effect.gen(function* () {
        // Mock data to simulate importing from grid
        mockDataAdapter.queryLatestValues.mockReturnValue(
          Effect.succeed({
            voltage: 230,
            current_production: 0,
            current_load: 0,
            daily_import: 0,
            export_to_grid: 0,
            import_from_grid: 1230,
            battery_power: 0
          })
        );

        const controller = yield* ChargingSpeedController;
        const chargingSpeed = yield* controller.determineChargingSpeed(0);
        expect(chargingSpeed).toBe(0);
      }).pipe(Effect.provide(TestLayer()))
    );

    it.effect.each([
      [1800, 5],
      [4600, 15],
      [4700, 20],
      [4800, 20]
    ])("should calculate excess solar correctly with current charging speed", ([exportingToGrid, chargingSpeed]) =>
      Effect.gen(function* () {
        // Mock data to test excess solar calculation including current charging speed
        mockDataAdapter.queryLatestValues.mockReturnValue(
          Effect.succeed({
            voltage: 230,
            current_production: 0,
            current_load: 0,
            daily_import: 0,
            export_to_grid: exportingToGrid,
            import_from_grid: 0,
            battery_power: 0
          })
        );

        const controller = yield* ChargingSpeedController;
        const resultingChargingSpeed = yield* controller.determineChargingSpeed(10);
        expect(resultingChargingSpeed).toEqual(10 + chargingSpeed);
      }).pipe(Effect.provide(TestLayer()))
    );

    it.effect("should include battery charging power in excess calculation when battery is charging", () =>
      Effect.gen(function* () {
        // Battery charging at 1650W, no grid export
        // excessSolar = 1650 + 0 - 100 (buffer) + 0 = 1550W
        // 1550 / 230 = 6.7A -> rounded to 5A (multipleOf=5)
        mockDataAdapter.queryLatestValues.mockReturnValue(
          Effect.succeed({
            voltage: 230,
            current_production: 0,
            current_load: 0,
            daily_import: 0,
            export_to_grid: 0,
            import_from_grid: 0,
            battery_power: -1650 // Battery charging
          })
        );

        const controller = yield* ChargingSpeedController;
        const chargingSpeed = yield* controller.determineChargingSpeed(0);
        expect(chargingSpeed).toBe(5);
      }).pipe(Effect.provide(TestLayer({ bufferPower: 100, multipleOf: 5 })))
    );

    it.effect("should combine battery charging power and grid export for total excess", () =>
      Effect.gen(function* () {
        // Battery charging at 1650W + grid export 1000W = 2650W excess
        // excessSolar = 1650 + 1000 - 100 (buffer) + 0 = 2550W
        // 2550 / 230 = 11A -> rounded to 10A (multipleOf=5)
        mockDataAdapter.queryLatestValues.mockReturnValue(
          Effect.succeed({
            voltage: 230,
            current_production: 0,
            current_load: 0,
            daily_import: 0,
            export_to_grid: 1000,
            import_from_grid: 0,
            battery_power: -1650 // Battery charging
          })
        );

        const controller = yield* ChargingSpeedController;
        const chargingSpeed = yield* controller.determineChargingSpeed(0);
        expect(chargingSpeed).toBe(10);
      }).pipe(Effect.provide(TestLayer({ bufferPower: 100, multipleOf: 5 })))
    );

    it.effect("should use only grid export when battery is not charging (discharging)", () =>
      Effect.gen(function* () {
        // Battery discharging at 500W (providing power), grid export 2000W
        // Should use only grid export (netExport = 2000 - 0 = 2000W)
        // excessSolar = 2000 - 100 (buffer) = 1900W
        // 1900 / 230 = 8.2A -> rounded to 5A (multipleOf=5)
        mockDataAdapter.queryLatestValues.mockReturnValue(
          Effect.succeed({
            voltage: 230,
            current_production: 0,
            current_load: 0,
            daily_import: 0,
            export_to_grid: 2000,
            import_from_grid: 0,
            battery_power: 500 // Battery discharging
          })
        );

        const controller = yield* ChargingSpeedController;
        const chargingSpeed = yield* controller.determineChargingSpeed(0);
        expect(chargingSpeed).toBe(5);
      }).pipe(Effect.provide(TestLayer({ bufferPower: 100, multipleOf: 5 })))
    );

    it.effect("should subtract battery discharge when demand exceeds solar production", () =>
      Effect.gen(function* () {
        // Battery discharging at 2000W to meet high demand, importing 500W from grid
        // This means demand > solar, battery is helping cover the deficit
        // netExport = 0 - 500 = -500W (importing)
        // excessSolar = -500 - 2000 - 100 (buffer) + 0 = -2600W
        // Should return 0A as there's no excess
        mockDataAdapter.queryLatestValues.mockReturnValue(
          Effect.succeed({
            voltage: 230,
            current_production: 0,
            current_load: 0,
            daily_import: 0,
            export_to_grid: 0,
            import_from_grid: 500,
            battery_power: 2000 // Battery discharging to meet demand
          })
        );

        const controller = yield* ChargingSpeedController;
        const chargingSpeed = yield* controller.determineChargingSpeed(0);
        expect(chargingSpeed).toBe(0);
      }).pipe(Effect.provide(TestLayer({ bufferPower: 100, multipleOf: 5 })))
    );

    it.effect("should correctly calculate excess when battery discharges with solar surplus", () =>
      Effect.gen(function* () {
        // Battery discharging at 1000W, exporting 1500W to grid
        // This means solar > demand, battery discharge is NOT needed for home
        // netExport = 1500 - 0 = 1500W
        // excessSolar = 1500 - 1000 - 100 (buffer) + 0 = 400W
        // 400 / 230 = 1.7A -> rounded to 0A (multipleOf=5)
        mockDataAdapter.queryLatestValues.mockReturnValue(
          Effect.succeed({
            voltage: 230,
            current_production: 0,
            current_load: 0,
            daily_import: 0,
            export_to_grid: 1500,
            import_from_grid: 0,
            battery_power: 1000 // Battery discharging
          })
        );

        const controller = yield* ChargingSpeedController;
        const chargingSpeed = yield* controller.determineChargingSpeed(0);
        expect(chargingSpeed).toBe(0);
      }).pipe(Effect.provide(TestLayer({ bufferPower: 100, multipleOf: 5 })))
    );
  });
});
