import { describe, it, expect } from "@effect/vitest";
import {
  calculateSunTimes,
  calculateDefaultMonthlyPeakFactors,
  expectedCapacityKw,
} from "../../../../charging-speed-controller/weather-aware-buffer/solar-calculations.js";
import type { WeatherAwareBufferConfig } from "../../../../charging-speed-controller/weather-aware-buffer/types.js";

describe("solar-calculations", () => {
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
});
