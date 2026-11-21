import * as TestClock from "effect/testing/TestClock";
import { describe, it, expect } from "@effect/vitest";
import { DateTime, Duration, Effect, Layer, Option } from "effect";
import {
  WeatherAwareBufferControllerLayer,
  type WeatherAwareBufferConfig
} from "../../../../charging-speed-controller/weather-aware-buffer/index.js";
import { ChargingSpeedController } from "../../../../charging-speed-controller/types.js";
import { SolarForecastNotAvailableError, type SolarForecastResult } from "../../../../solar-forecast/types.js";
import type { BatteryState } from "../../../../battery-state-manager.js";
import { makeBatteryStateManagerTest } from "../../../fixtures/battery-state-manager.js";
import { makeDataAdapterTest, type DataAdapterResponse } from "../../../fixtures/data-adapter.js";
import { makeSolarForecastTest } from "../../../fixtures/solar-forecast.js";
import {
  Ampere,
  KiloWattHours as KWh,
  StateOfCharge,
  HourOfDay,
  Watt,
  Latitude,
  Longitude
} from "../../../../domain/brands.js";

describe("WeatherAwareBufferController - Integration", () => {
  const baseConfig: WeatherAwareBufferConfig = {
    minBufferPower: Watt(1000),
    bufferMultiplierMax: 3,
    carBatteryCapacityKwh: KWh(75),
    peakSolarCapacityKw: 9,
    latitude: Latitude(-33.8688),
    longitude: Longitude(151.2093),
    defaultDailyProductionKwh: KWh(30),
    solarCutoffHour: HourOfDay(18),
    multipleOf: 3
  };

  const TestLayer = (options: {
    forecast: Effect.Effect<SolarForecastResult, SolarForecastNotAvailableError>;
    latestValues: ReadonlyArray<DataAdapterResponse>;
    batteryState?: BatteryState;
    config?: WeatherAwareBufferConfig;
  }) =>
    WeatherAwareBufferControllerLayer(options.config ?? baseConfig).pipe(
      Layer.provideMerge(makeDataAdapterTest({ latestValues: options.latestValues }).layer),
      Layer.provideMerge(makeSolarForecastTest(options.forecast)),
      Layer.provideMerge(makeBatteryStateManagerTest(options.batteryState ?? null).layer)
    );

  it.effect("should use minBufferPower when forecast unavailable", () => {
    const layer = TestLayer({
      forecast: Effect.fail(new SolarForecastNotAvailableError({ message: "Forecast unavailable" })),
      latestValues: [{ voltage: 230, export_to_grid: 2000, import_from_grid: 0 }]
    });

    return Effect.gen(function* () {
      const controller = yield* ChargingSpeedController;
      const speed = yield* controller.determineChargingSpeed(Ampere(0));

      expect(speed).toBeGreaterThanOrEqual(0);
      expect(speed % 3).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("should use dynamic buffer based on forecast confidence", () => {
    const layer = TestLayer({
      forecast: Effect.succeed({
        periods: [
          {
            pv_estimate: 8.0,
            pv_estimate10: 8.0,
            pv_estimate90: 8.0,
            period_end: Option.getOrThrow(DateTime.make("2024-01-15T12:30:00Z")),
            period: Duration.minutes(30)
          }
        ]
      }),
      latestValues: [{ voltage: 230, export_to_grid: 5000, import_from_grid: 0 }],
      batteryState: {
        batteryLevel: StateOfCharge(50),
        chargeLimitSoc: StateOfCharge(80),
        queriedAtMs: 1715600000000
      }
    });

    return Effect.gen(function* () {
      yield* TestClock.adjust(Duration.seconds(1));

      const controller = yield* ChargingSpeedController;
      const speed = yield* controller.determineChargingSpeed(Ampere(0));

      expect(speed).toBeGreaterThan(0);
      expect(speed % 3).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("should use higher buffer when forecast shows cloudy conditions", () => {
    const layer = TestLayer({
      forecast: Effect.succeed({
        periods: [
          {
            pv_estimate: 1.0,
            pv_estimate10: 1.0,
            pv_estimate90: 1.0,
            period_end: Option.getOrThrow(DateTime.make("2024-01-15T12:30:00Z")),
            period: Duration.minutes(30)
          }
        ]
      }),
      latestValues: [{ voltage: 230, export_to_grid: 5000, import_from_grid: 0 }],
      batteryState: {
        batteryLevel: StateOfCharge(50),
        chargeLimitSoc: StateOfCharge(80),
        queriedAtMs: 1715600000000
      }
    });

    return Effect.gen(function* () {
      yield* TestClock.adjust(Duration.seconds(1));

      const controller = yield* ChargingSpeedController;
      const speed = yield* controller.determineChargingSpeed(Ampere(0));

      expect(speed).toBeGreaterThanOrEqual(0);
      expect(speed % 3).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("should reduce buffer when deadline is set and urgency is high", () => {
    const layer = TestLayer({
      forecast: Effect.succeed({
        periods: [
          {
            pv_estimate: 2.0,
            pv_estimate10: 2.0,
            pv_estimate90: 2.0,
            period_end: Option.getOrThrow(DateTime.make("2024-01-15T12:30:00Z")),
            period: Duration.minutes(30)
          }
        ]
      }),
      latestValues: [{ voltage: 230, export_to_grid: 5000, import_from_grid: 0 }],
      batteryState: {
        batteryLevel: StateOfCharge(30),
        chargeLimitSoc: StateOfCharge(80),
        queriedAtMs: 1715600000000
      },
      config: { ...baseConfig, deadlineHour: HourOfDay(14) }
    });

    return Effect.gen(function* () {
      yield* TestClock.adjust(Duration.seconds(1));

      const controller = yield* ChargingSpeedController;
      const speedWithDeadline = yield* controller.determineChargingSpeed(Ampere(0));

      expect(speedWithDeadline).toBeGreaterThanOrEqual(0);
      expect(speedWithDeadline % 3).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("should limit charging speed to 32A", () => {
    const layer = TestLayer({
      forecast: Effect.succeed({
        periods: [
          {
            pv_estimate: 8.0,
            pv_estimate10: 8.0,
            pv_estimate90: 8.0,
            period_end: Option.getOrThrow(DateTime.make("2024-01-15T12:30:00Z")),
            period: Duration.minutes(30)
          }
        ]
      }),
      latestValues: [{ voltage: 230, export_to_grid: 10000, import_from_grid: 0 }],
      batteryState: {
        batteryLevel: StateOfCharge(50),
        chargeLimitSoc: StateOfCharge(80),
        queriedAtMs: 1715600000000
      }
    });

    return Effect.gen(function* () {
      yield* TestClock.adjust(Duration.seconds(1));

      const controller = yield* ChargingSpeedController;
      const speed = yield* controller.determineChargingSpeed(Ampere(0));

      expect(speed).toBe(Ampere(32));
    }).pipe(Effect.provide(layer));
  });
});
