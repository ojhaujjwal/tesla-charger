import { describe, it, expect, beforeEach } from "@effect/vitest";
import { vi } from "vitest";
import { type MockedObject } from "vitest";
import { Effect, Layer } from "effect";
import { BatteryAwareChargingSpeedControllerLayer } from "../../../charging-speed-controller/battery-aware-controller.js";
import { ChargingSpeedController } from "../../../charging-speed-controller/types.js";
import { DataAdapter, type IDataAdapter } from "../../../data-adapter/types.js";

describe('BatteryAwareChargingSpeedController', () => {
  let mockBaseController: MockedObject<ChargingSpeedController['Type']>;
  let mockDataAdapter: MockedObject<IDataAdapter>;

  beforeEach(() => {
    mockBaseController = {
      determineChargingSpeed: vi.fn(),
    };

    mockDataAdapter = {
      queryLatestValues: vi.fn(),
      getLowestValueInLastXMinutes: vi.fn(),
    };
  });

  const getTestLayer = () => {
    const baseControllerLayer = Layer.succeed(
      ChargingSpeedController,
      ChargingSpeedController.of(mockBaseController)
    );

    return BatteryAwareChargingSpeedControllerLayer(baseControllerLayer).pipe(
      Layer.provideMerge(Layer.succeed(DataAdapter, mockDataAdapter))
    );
  };

  it.effect('should return 0 when battery is discharging (importing)', () =>
    Effect.gen(function* () {
      mockDataAdapter.queryLatestValues.mockReturnValue(
        Effect.succeed({ 
          battery_power: 5000,
          voltage: 230,
          current_production: 0,
          current_load: 0,
          daily_import: 0,
          export_to_grid: 0,
          import_from_grid: 0,
        })
      );

      const controller = yield* ChargingSpeedController;
      const speed = yield* controller.determineChargingSpeed(10);

      expect(speed).toBe(0);
      expect(mockBaseController.determineChargingSpeed).not.toHaveBeenCalled();
    }).pipe(Effect.provide(getTestLayer()))
  );

  it.effect('should delegate to base controller when battery is idle (battery_power = 0)', () =>
    Effect.gen(function* () {
      mockDataAdapter.queryLatestValues.mockReturnValue(
        Effect.succeed({ 
          battery_power: 0,
          voltage: 230,
          current_production: 5000,
          current_load: 0,
          daily_import: 0,
          export_to_grid: 5000,
          import_from_grid: 0,
        })
      );
      mockBaseController.determineChargingSpeed.mockReturnValue(Effect.succeed(6));

      const controller = yield* ChargingSpeedController;
      const speed = yield* controller.determineChargingSpeed(10);

      expect(speed).toBe(6);
      expect(mockBaseController.determineChargingSpeed).toHaveBeenCalledWith(10);
    }).pipe(Effect.provide(getTestLayer()))
  );

  it.effect('should delegate to base controller when battery is charging (exporting, battery_power < 0)', () =>
    Effect.gen(function* () {
      mockDataAdapter.queryLatestValues.mockReturnValue(
        Effect.succeed({ 
          battery_power: -3000,
          voltage: 230,
          current_production: 5000,
          current_load: 0,
          daily_import: 0,
          export_to_grid: 2000,
          import_from_grid: 0,
        })
      );
      mockBaseController.determineChargingSpeed.mockReturnValue(Effect.succeed(9));

      const controller = yield* ChargingSpeedController;
      const speed = yield* controller.determineChargingSpeed(10);

      expect(speed).toBe(9);
      expect(mockBaseController.determineChargingSpeed).toHaveBeenCalledWith(10);
    }).pipe(Effect.provide(getTestLayer()))
  );
});
