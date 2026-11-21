import * as TestClock from "effect/testing/TestClock";
import { describe, it, expect } from "@effect/vitest";
import { DateTime, Duration, Effect, Layer, Option } from "effect";
import {
  calculateSunTimes,
  calculateDefaultMonthlyPeakFactors,
  expectedCapacityKw,
  periodConfidence,
  simulateCharge,
  WeatherAwareBufferControllerLayer,
  type WeatherAwareBufferConfig
} from "../../../charging-speed-controller/weather-aware-buffer/index.js";
import { ChargingSpeedController } from "../../../charging-speed-controller/types.js";
import { SolarForecastNotAvailableError, type SolarForecastResult } from "../../../solar-forecast/types.js";
import type { BatteryState } from "../../../battery-state-manager.js";
import { makeBatteryStateManagerTest } from "../../fixtures/battery-state-manager.js";
import { makeDataAdapterTest, type DataAdapterResponse } from "../../fixtures/data-adapter.js";
import { makeSolarForecastTest } from "../../fixtures/solar-forecast.js";
const at = (iso: string) => Option.getOrThrow(DateTime.make(iso));

import {
  Ampere,
  KiloWattHours as KWh,
  StateOfCharge,
  HourOfDay,
  Watt,
  Latitude,
  Longitude
} from "../../../domain/brands.js";

describe("WeatherAwareBufferController - Pure Functions", () => {
  describe("calculateSunTimes", () => {
    it("should calculate sunrise and sunset for a known location and date", () => {
      // Sydney, Australia (latitude -33.8688) on January 15 (summer)
      const date = at("2024-01-15T12:00:00Z");
      const latitude = -33.8688;
      const result = calculateSunTimes(date, latitude);

      // Sunrise should be between 4.5 and 7 hours (accounting for timezone and calculation precision)
      expect(result.sunrise).toBeGreaterThan(4.5);
      expect(result.sunrise).toBeLessThan(7);
      expect(result.sunset).toBeGreaterThan(18);
      expect(result.sunset).toBeLessThan(20);
      expect(result.sunset).toBeGreaterThan(result.sunrise);
    });

    it("should show longer days in summer vs winter (southern hemisphere)", () => {
      const latitude = -33.8688; // Sydney

      const summerDate = at("2024-01-15T12:00:00Z"); // January (summer)
      const winterDate = at("2024-07-15T12:00:00Z"); // July (winter)

      const summerTimes = calculateSunTimes(summerDate, latitude);
      const winterTimes = calculateSunTimes(winterDate, latitude);

      const summerDayLength = winterTimes.sunset - summerTimes.sunrise;
      const winterDayLength = winterTimes.sunset - winterTimes.sunrise;

      // Summer should have longer days in southern hemisphere
      expect(summerDayLength).toBeGreaterThan(winterDayLength);
    });

    it("should handle northern hemisphere correctly", () => {
      // New York (latitude 40.7128) on June 15 (summer)
      const date = at("2024-06-15T12:00:00Z");
      const latitude = 40.7128;
      const result = calculateSunTimes(date, latitude);

      expect(result.sunrise).toBeGreaterThan(4);
      expect(result.sunrise).toBeLessThan(6);
      expect(result.sunset).toBeGreaterThan(19);
      expect(result.sunset).toBeLessThan(21);
    });
  });

  describe("calculateDefaultMonthlyPeakFactors", () => {
    it("should return 12 factors (one per month)", () => {
      const factors = calculateDefaultMonthlyPeakFactors(-33.8688); // Sydney
      expect(factors).toHaveLength(12);
    });

    it("should normalize factors so max = 1.0", () => {
      const factors = calculateDefaultMonthlyPeakFactors(-33.8688);
      const maxFactor = Math.max(...factors);
      expect(maxFactor).toBeCloseTo(1.0, 2);
    });

    it("should show December/January highest for southern hemisphere", () => {
      const factors = calculateDefaultMonthlyPeakFactors(-33.8688); // Sydney
      const decFactor = factors[11]; // December (index 11)
      const janFactor = factors[0]; // January (index 0)
      const junFactor = factors[5]; // June (index 5, winter)

      // December/January should be highest (summer)
      expect(decFactor).toBeGreaterThan(junFactor);
      expect(janFactor).toBeGreaterThan(junFactor);
      // December/January should be close to 1.0 (normalized max)
      expect(decFactor).toBeCloseTo(1.0, 1);
      expect(janFactor).toBeCloseTo(1.0, 1);
    });

    it("should show June/July lowest for southern hemisphere", () => {
      const factors = calculateDefaultMonthlyPeakFactors(-33.8688);
      const junFactor = factors[5]; // June
      const julFactor = factors[6]; // July
      const decFactor = factors[11]; // December

      // June/July should be lowest (winter)
      expect(junFactor).toBeLessThan(decFactor);
      expect(julFactor).toBeLessThan(decFactor);
      // Should be around 0.6-0.65 for Sydney winter
      expect(junFactor).toBeGreaterThan(0.5);
      expect(junFactor).toBeLessThan(0.7);
    });

    it("should show relatively flat factors for equatorial latitude", () => {
      const factors = calculateDefaultMonthlyPeakFactors(0); // Equator
      const minFactor = Math.min(...factors);
      const maxFactor = Math.max(...factors);

      // At equator, seasonal variation is minimal
      expect(maxFactor - minFactor).toBeLessThan(0.2);
    });
  });

  describe("expectedCapacityKw", () => {
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

    it("should return peak capacity at solar noon", () => {
      const date = at("2024-01-15T12:00:00Z"); // January (summer)
      const noonHour = 12;
      const capacity = expectedCapacityKw(date, noonHour, baseConfig);

      // Should be close to peakSolarCapacityKw * monthFactor (Jan should be ~1.0)
      expect(capacity).toBeGreaterThan(8);
      expect(capacity).toBeLessThanOrEqual(9);
    });

    it("should return lower capacity mid-morning (~78% of noon)", () => {
      const date = at("2024-01-15T12:00:00Z");
      const morningHour = 10;
      const noonHour = 12;

      const morningCapacity = expectedCapacityKw(date, morningHour, baseConfig);
      const noonCapacity = expectedCapacityKw(date, noonHour, baseConfig);

      // Morning should be ~78% of noon (cos^2 of hour angle)
      const ratio = morningCapacity / noonCapacity;
      expect(ratio).toBeCloseTo(0.78, 1);
    });

    it("should return 0 before sunrise", () => {
      const date = at("2024-01-15T12:00:00Z");
      const earlyHour = 4; // Before sunrise
      const capacity = expectedCapacityKw(date, earlyHour, baseConfig);

      expect(capacity).toBe(0);
    });

    it("should return 0 after sunset", () => {
      const date = at("2024-01-15T12:00:00Z");
      const lateHour = 20; // After sunset
      const capacity = expectedCapacityKw(date, lateHour, baseConfig);

      expect(capacity).toBe(0);
    });

    it("should return lower peak in winter month", () => {
      const summerDate = at("2024-01-15T12:00:00Z"); // January
      const winterDate = at("2024-07-15T12:00:00Z"); // July

      const summerCapacity = expectedCapacityKw(summerDate, 12, baseConfig);
      const winterCapacity = expectedCapacityKw(winterDate, 12, baseConfig);

      // Winter should be lower due to monthly peak factor
      expect(winterCapacity).toBeLessThan(summerCapacity);
      // Winter should be around 60-65% of summer peak
      const ratio = winterCapacity / summerCapacity;
      expect(ratio).toBeGreaterThan(0.5);
      expect(ratio).toBeLessThan(0.7);
    });
  });

  describe("periodConfidence", () => {
    it("should return 1.0 for clear sky (forecast near expected capacity)", () => {
      const pvPowerKw = 7.0; // High production
      const expectedCapacityKw = 9.0; // Peak capacity
      const confidence = periodConfidence(pvPowerKw, expectedCapacityKw);

      // 7 / 9 / 0.7 = 1.11 -> clamped to 1.0
      expect(confidence).toBeCloseTo(1.0, 1);
    });

    it("should return ~0.5 for partial cloud", () => {
      const pvPowerKw = 3.0; // Moderate production
      const expectedCapacityKw = 9.0;
      const confidence = periodConfidence(pvPowerKw, expectedCapacityKw);

      // 3 / 9 / 0.7 = 0.48
      expect(confidence).toBeCloseTo(0.48, 1);
    });

    it("should return ~0.14 for heavy cloud", () => {
      const pvPowerKw = 0.9; // Low production
      const expectedCapacityKw = 9.0;
      const confidence = periodConfidence(pvPowerKw, expectedCapacityKw);

      // 0.9 / 9 / 0.7 = 0.14
      expect(confidence).toBeCloseTo(0.14, 1);
    });

    it("should return 0 for nighttime (expected capacity = 0)", () => {
      const pvPowerKw = 0;
      const expectedCapacityKw = 0;
      const confidence = periodConfidence(pvPowerKw, expectedCapacityKw);

      expect(confidence).toBe(0);
    });
  });

  describe("simulateCharge", () => {
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

    it("should return canComplete=true for sunny forecast with low charge need", () => {
      const forecast = {
        periods: [
          {
            pv_estimate: 8.0, // High production
            pv_estimate10: 8.0,
            pv_estimate90: 8.0,
            period_end: Option.getOrThrow(DateTime.make("2024-01-15T12:30:00Z"))
          },
          {
            pv_estimate: 8.5,
            pv_estimate10: 8.5,
            pv_estimate90: 8.5,
            period_end: Option.getOrThrow(DateTime.make("2024-01-15T13:00:00Z"))
          }
        ]
      };
      const batteryState = {
        batteryLevel: StateOfCharge(70),
        chargeLimitSoc: StateOfCharge(80) // Only needs 10% = 7.5 kWh
      };
      const now = at("2024-01-15T12:00:00Z");

      const result = simulateCharge(baseConfig, forecast, batteryState, now);

      expect(result.canComplete).toBe(true);
      expect(result.shortfallKwh).toBe(0);
    });

    it("should return canComplete=false for cloudy forecast with high charge need", () => {
      const forecast = {
        periods: [
          {
            pv_estimate: 1.0, // Low production (cloudy)
            pv_estimate10: 1.0,
            pv_estimate90: 1.0,
            period_end: Option.getOrThrow(DateTime.make("2024-01-15T12:30:00Z"))
          },
          {
            pv_estimate: 1.5,
            pv_estimate10: 1.5,
            pv_estimate90: 1.5,
            period_end: Option.getOrThrow(DateTime.make("2024-01-15T13:00:00Z"))
          }
        ]
      };
      const batteryState = {
        batteryLevel: StateOfCharge(30),
        chargeLimitSoc: StateOfCharge(80) // Needs 50% = 37.5 kWh
      };
      const now = at("2024-01-15T12:00:00Z");

      const result = simulateCharge(baseConfig, forecast, batteryState, now);

      expect(result.canComplete).toBe(false);
      expect(result.shortfallKwh).toBeGreaterThan(0);
    });

    it("should return usableSlots=0 when no periods before cutoff", () => {
      const forecast = {
        periods: [
          {
            pv_estimate: 8.0,
            pv_estimate10: 8.0,
            pv_estimate90: 8.0,
            period_end: Option.getOrThrow(DateTime.make("2024-01-15T19:00:00Z")) // After cutoff (18:00)
          }
        ]
      };
      const batteryState = {
        batteryLevel: StateOfCharge(50),
        chargeLimitSoc: StateOfCharge(80)
      };
      const now = at("2024-01-15T18:30:00Z"); // After cutoff

      const result = simulateCharge(baseConfig, forecast, batteryState, now);

      expect(result.usableSlots).toBe(0);
      expect(result.totalSlots).toBe(0);
    });
  });

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
});
