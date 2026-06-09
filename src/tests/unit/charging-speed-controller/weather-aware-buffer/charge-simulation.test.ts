import { describe, it, expect } from "@effect/vitest";
import { simulateCharge } from "../../../../charging-speed-controller/weather-aware-buffer/charge-simulation.js";
import type { WeatherAwareBufferConfig } from "../../../../charging-speed-controller/weather-aware-buffer/types.js";
import { KiloWattHours as KWh, StateOfCharge, HourOfDay } from "../../../../domain/brands.js";

describe("charge-simulation", () => {
  describe("simulateCharge", () => {
    const baseConfig: WeatherAwareBufferConfig = {
      minBufferPower: 1000,
      bufferMultiplierMax: 3,
      carBatteryCapacityKwh: KWh(75),
      peakSolarCapacityKw: 9,
      latitude: -33.8688,
      longitude: 151.2093,
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
            period_end: "2024-01-15T12:30:00Z"
          },
          {
            pv_estimate: 8.5,
            pv_estimate10: 8.5,
            pv_estimate90: 8.5,
            period_end: "2024-01-15T13:00:00Z"
          }
        ]
      };
      const batteryState = {
        batteryLevel: StateOfCharge(70),
        chargeLimitSoc: StateOfCharge(80) // Only needs 10% = 7.5 kWh
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
            period_end: "2024-01-15T12:30:00Z"
          },
          {
            pv_estimate: 1.5,
            pv_estimate10: 1.5,
            pv_estimate90: 1.5,
            period_end: "2024-01-15T13:00:00Z"
          }
        ]
      };
      const batteryState = {
        batteryLevel: StateOfCharge(30),
        chargeLimitSoc: StateOfCharge(80) // Needs 50% = 37.5 kWh
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
            period_end: "2024-01-15T19:00:00Z" // After cutoff (18:00)
          }
        ]
      };
      const batteryState = {
        batteryLevel: StateOfCharge(50),
        chargeLimitSoc: StateOfCharge(80)
      };
      const now = new Date("2024-01-15T18:30:00Z"); // After cutoff

      const result = simulateCharge(baseConfig, forecast, batteryState, now);

      expect(result.usableSlots).toBe(0);
      expect(result.totalSlots).toBe(0);
    });
  });
});
