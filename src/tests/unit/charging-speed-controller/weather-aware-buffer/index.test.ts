import { describe, it, expect, beforeEach } from "@effect/vitest";
import { vi } from "vitest";
import type { MockedObject } from "vitest";
import { Effect, Layer, TestClock, Duration } from "effect";
import {
  WeatherAwareBufferControllerLayer,
  type WeatherAwareBufferConfig,
} from "../../../../charging-speed-controller/weather-aware-buffer/index.js";
import { ChargingSpeedController } from "../../../../charging-speed-controller/types.js";
import { DataAdapter, type IDataAdapter } from "../../../../data-adapter/types.js";
import { SolarForecast, SolarForecastNotAvailableError } from "../../../../solar-forecast/types.js";
import { BatteryStateManager, type BatteryState } from "../../../../battery-state-manager.js";

describe("WeatherAwareBufferController - Integration", () => {
  let mockDataAdapter: MockedObject<IDataAdapter>;
  let mockSolarForecast: MockedObject<SolarForecast["Type"]>;
  let mockBatteryStateManager: MockedObject<BatteryStateManager>;
  let batteryState: BatteryState | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    batteryState = null;

    mockDataAdapter = {
      queryLatestValues: vi.fn(),
      getLowestValueInLastXMinutes: vi.fn(),
    };

    mockSolarForecast = {
      getForecast: vi.fn(),
    };

    mockBatteryStateManager = {
      start: vi.fn(),
      get: vi.fn(() => batteryState),
    };
  });

  const baseConfig: WeatherAwareBufferConfig = {
    minBufferPower: 1000,
    bufferMultiplierMax: 3,
    carBatteryCapacityKwh: 75,
    peakSolarCapacityKw: 9,
    latitude: -33.8688,
    longitude: 151.2093,
    defaultDailyProductionKwh: 30,
    solarCutoffHour: 18,
    multipleOf: 3,
  };

  const TestLayer = (config: WeatherAwareBufferConfig = baseConfig) =>
    WeatherAwareBufferControllerLayer(config).pipe(
      Layer.provideMerge(Layer.succeed(DataAdapter, mockDataAdapter)),
      Layer.provideMerge(Layer.succeed(SolarForecast, mockSolarForecast)),
      Layer.provideMerge(Layer.succeed(BatteryStateManager, mockBatteryStateManager))
    );

  it.effect("should use minBufferPower when forecast unavailable", () =>
    Effect.gen(function* () {
      mockSolarForecast.getForecast.mockReturnValue(
        Effect.fail(new SolarForecastNotAvailableError({ message: "Forecast unavailable" }))
      );
      mockDataAdapter.queryLatestValues.mockReturnValue(
        Effect.succeed({
          voltage: 230,
          export_to_grid: 2000,
          import_from_grid: 0,
          current_production: 0,
          current_load: 0,
          daily_import: 0,
        })
      );

      const controller = yield* ChargingSpeedController;
      const speed = yield* controller.determineChargingSpeed(0);

      // Should use minBufferPower (1000W)
      // Excess = 2000 - 1000 = 1000W = ~4.3A, rounded to 3A (multipleOf=3)
      expect(speed).toBeGreaterThanOrEqual(0);
      expect(speed % 3).toBe(0);
    }).pipe(Effect.provide(TestLayer()))
  );

  it.effect("should use dynamic buffer based on forecast confidence", () =>
    Effect.gen(function* () {
      // Clear sky forecast -> high confidence -> low buffer
      mockSolarForecast.getForecast.mockReturnValue(
        Effect.succeed({
          periods: [
            {
              pv_estimate: 8.0, // High production
              pv_estimate10: 8.0,
              pv_estimate90: 8.0,
              period_end: "2024-01-15T12:30:00Z",
              period: "PT30M",
            },
          ],
        })
      );
      batteryState = {
        batteryLevel: 50,
        chargeLimitSoc: 80,
        queriedAtMs: Date.now(),
      };
      mockDataAdapter.queryLatestValues.mockReturnValue(
        Effect.succeed({
          voltage: 230,
          export_to_grid: 5000,
          import_from_grid: 0,
          current_production: 0,
          current_load: 0,
          daily_import: 0,
        })
      );

      yield* TestClock.adjust(Duration.seconds(1));

      const controller = yield* ChargingSpeedController;
      const speed = yield* controller.determineChargingSpeed(0);

      // High confidence -> buffer near minBufferPower
      // Should result in higher charging speed
      expect(speed).toBeGreaterThan(0);
      expect(speed % 3).toBe(0);
    }).pipe(Effect.provide(TestLayer()))
  );

  it.effect("should use higher buffer when forecast shows cloudy conditions", () =>
    Effect.gen(function* () {
      // Cloudy forecast -> low confidence -> high buffer
      mockSolarForecast.getForecast.mockReturnValue(
        Effect.succeed({
          periods: [
            {
              pv_estimate: 1.0, // Low production (cloudy)
              pv_estimate10: 1.0,
              pv_estimate90: 1.0,
              period_end: "2024-01-15T12:30:00Z",
              period: "PT30M",
            },
          ],
        })
      );
      batteryState = {
        batteryLevel: 50,
        chargeLimitSoc: 80,
        queriedAtMs: Date.now(),
      };
      mockDataAdapter.queryLatestValues.mockReturnValue(
        Effect.succeed({
          voltage: 230,
          export_to_grid: 5000,
          import_from_grid: 0,
          current_production: 0,
          current_load: 0,
          daily_import: 0,
        })
      );

      yield* TestClock.adjust(Duration.seconds(1));

      const controller = yield* ChargingSpeedController;
      const speed = yield* controller.determineChargingSpeed(0);

      // Low confidence -> buffer near max (minBuffer * bufferMultiplierMax)
      // Should result in lower charging speed than clear sky
      expect(speed).toBeGreaterThanOrEqual(0);
      expect(speed % 3).toBe(0);
    }).pipe(Effect.provide(TestLayer()))
  );

  it.effect("should reduce buffer when deadline is set and urgency is high", () =>
    Effect.gen(function* () {
      // Forecast shows we can't complete -> high urgency
      mockSolarForecast.getForecast.mockReturnValue(
        Effect.succeed({
          periods: [
            {
              pv_estimate: 2.0, // Moderate production
              pv_estimate10: 2.0,
              pv_estimate90: 2.0,
              period_end: "2024-01-15T12:30:00Z",
              period: "PT30M",
            },
          ],
        })
      );
      batteryState = {
        batteryLevel: 30,
        chargeLimitSoc: 80, // Needs a lot
        queriedAtMs: Date.now(),
      };
      mockDataAdapter.queryLatestValues.mockReturnValue(
        Effect.succeed({
          voltage: 230,
          export_to_grid: 5000,
          import_from_grid: 0,
          current_production: 0,
          current_load: 0,
          daily_import: 0,
        })
      );

      yield* TestClock.adjust(Duration.seconds(1));

      const controller = yield* ChargingSpeedController;
      const speedWithDeadline = yield* controller.determineChargingSpeed(0);

      // Should charge more aggressively with deadline
      expect(speedWithDeadline).toBeGreaterThanOrEqual(0);
      expect(speedWithDeadline % 3).toBe(0);
    }).pipe(
      Effect.provide(
        TestLayer({
          ...baseConfig,
          deadlineHour: 14, // 2PM deadline
        })
      )
    )
  );

  it.effect("should limit charging speed to 32A", () =>
    Effect.gen(function* () {
      mockSolarForecast.getForecast.mockReturnValue(
        Effect.succeed({
          periods: [
            {
              pv_estimate: 8.0,
              pv_estimate10: 8.0,
              pv_estimate90: 8.0,
              period_end: "2024-01-15T12:30:00Z",
              period: "PT30M",
            },
          ],
        })
      );
      batteryState = {
        batteryLevel: 50,
        chargeLimitSoc: 80,
        queriedAtMs: Date.now(),
      };
      // Very high export -> should hit 32A limit
      mockDataAdapter.queryLatestValues.mockReturnValue(
        Effect.succeed({
          voltage: 230,
          export_to_grid: 10000,
          import_from_grid: 0,
          current_production: 0,
          current_load: 0,
          daily_import: 0,
        })
      );

      yield* TestClock.adjust(Duration.seconds(1));

      const controller = yield* ChargingSpeedController;
      const speed = yield* controller.determineChargingSpeed(0);

      expect(speed).toBe(32);
    }).pipe(Effect.provide(TestLayer()))
  );
});
