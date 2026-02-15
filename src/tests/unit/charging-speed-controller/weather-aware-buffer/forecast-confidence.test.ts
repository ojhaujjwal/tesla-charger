import { describe, it, expect } from "@effect/vitest";
import { periodConfidence } from "../../../../charging-speed-controller/weather-aware-buffer/forecast-confidence.js";

describe("forecast-confidence", () => {
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
});
