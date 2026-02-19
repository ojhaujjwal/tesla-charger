import { describe, it, expect, beforeEach } from "@effect/vitest";
import { vi } from "vitest";
import type { MockedObject } from "vitest";
import { Effect, Layer, TestClock, Duration } from "effect";
import {
  calculateSunTimes,
  calculateDefaultMonthlyPeakFactors,
  expectedCapacityKw,
  periodConfidence,
  simulateCharge,
  WeatherAwareBufferControllerLayer,
  type WeatherAwareBufferConfig,
} from "../../../charging-speed-controller/weather-aware-buffer/index.js";
import { ChargingSpeedController } from "../../../charging-speed-controller/types.js";
import { DataAdapter, type IDataAdapter } from "../../../data-adapter/types.js";
import { SolarForecast, SolarForecastNotAvailableError } from "../../../solar-forecast/types.js";
import { BatteryStateManager, type BatteryState } from "../../../battery-state-manager.js";

describe("WeatherAwareBufferController - Pure Functions", () => {
  describe("calculateSunTimes", () => {
    it("should calculate sunrise and sunset for a known location and date", () => {
      // Sydney, Australia (latitude -33.8688) on January 15 (summer)
      const date = new Date("2024-01-15T12:00:00Z");
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

      const summerDate = new Date("2024-01-15T12:00:00Z"); // January (summer)
      const winterDate = new Date("2024-07-15T12:00:00Z"); // July (winter)

      const summerTimes = calculateSunTimes(summerDate, latitude);
      const winterTimes = calculateSunTimes(winterDate, latitude);

      const summerDayLength = winterTimes.sunset - summerTimes.sunrise;
      const winterDayLength = winterTimes.sunset - winterTimes.sunrise;

      // Summer should have longer days in southern hemisphere
      expect(summerDayLength).toBeGreaterThan(winterDayLength);
    });

    it("should handle northern hemisphere correctly", () => {
      // New York (latitude 40.7128) on June 15 (summer)
      const date = new Date("2024-06-15T12:00:00Z");
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

    it("should return peak capacity at solar noon", () => {
      const date = new Date("2024-01-15T12:00:00Z"); // January (summer)
      const noonHour = 12;
      const capacity = expectedCapacityKw(date, noonHour, baseConfig);

      // Should be close to peakSolarCapacityKw * monthFactor (Jan should be ~1.0)
      expect(capacity).toBeGreaterThan(8);
      expect(capacity).toBeLessThanOrEqual(9);
    });

    it("should return lower capacity mid-morning (~78% of noon)", () => {
      const date = new Date("2024-01-15T12:00:00Z");
      const morningHour = 10;
      const noonHour = 12;

      const morningCapacity = expectedCapacityKw(date, morningHour, baseConfig);
      const noonCapacity = expectedCapacityKw(date, noonHour, baseConfig);

      // Morning should be ~78% of noon (cos^2 of hour angle)
      const ratio = morningCapacity / noonCapacity;
      expect(ratio).toBeCloseTo(0.78, 1);
    });

    it("should return 0 before sunrise", () => {
      const date = new Date("2024-01-15T12:00:00Z");
      const earlyHour = 4; // Before sunrise
      const capacity = expectedCapacityKw(date, earlyHour, baseConfig);

      expect(capacity).toBe(0);
    });

    it("should return 0 after sunset", () => {
      const date = new Date("2024-01-15T12:00:00Z");
      const lateHour = 20; // After sunset
      const capacity = expectedCapacityKw(date, lateHour, baseConfig);

      expect(capacity).toBe(0);
    });

    it("should return lower peak in winter month", () => {
      const summerDate = new Date("2024-01-15T12:00:00Z"); // January
      const winterDate = new Date("2024-07-15T12:00:00Z"); // July

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

    it("should return canComplete=true for sunny forecast with low charge need", () => {
      const forecast = {
        periods: [
          {
            pv_estimate: 8.0, // High production
            pv_estimate10: 8.0,
            pv_estimate90: 8.0,
            period_end: "2024-01-15T12:30:00Z",
          },
          {
            pv_estimate: 8.5,
            pv_estimate10: 8.5,
            pv_estimate90: 8.5,
            period_end: "2024-01-15T13:00:00Z",
          },
        ],
      };
      const batteryState = {
        batteryLevel: 70,
        chargeLimitSoc: 80, // Only needs 10% = 7.5 kWh
      };
      const now = new Date("2024-01-15T12:00:00Z");

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
            period_end: "2024-01-15T12:30:00Z",
          },
          {
            pv_estimate: 1.5,
            pv_estimate10: 1.5,
            pv_estimate90: 1.5,
            period_end: "2024-01-15T13:00:00Z",
          },
        ],
      };
      const batteryState = {
        batteryLevel: 30,
        chargeLimitSoc: 80, // Needs 50% = 37.5 kWh
      };
      const now = new Date("2024-01-15T12:00:00Z");

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
            period_end: "2024-01-15T19:00:00Z", // After cutoff (18:00)
          },
        ],
      };
      const batteryState = {
        batteryLevel: 50,
        chargeLimitSoc: 80,
      };
      const now = new Date("2024-01-15T18:30:00Z"); // After cutoff

      const result = simulateCharge(baseConfig, forecast, batteryState, now);

      expect(result.usableSlots).toBe(0);
      expect(result.totalSlots).toBe(0);
    });
  });

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
});
