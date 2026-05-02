import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createInitialChargingSessionStats,
  withSessionStarted,
  recordFluctuation
} from "../../../domain/charging-session.js";
import { computeSessionSummary } from "../../../domain/session-summary.js";

const defaultStats = createInitialChargingSessionStats();

describe("SessionSummary computation", () => {
  describe("when no session was started", () => {
    it("produces 0 for duration, energy, and cost", () => {
      const summary = computeSessionSummary({
        stats: defaultStats,
        finalChargeEnergyAdded: 0,
        finalDailyImport: 0,
        finalVoltage: 230,
        costPerKwh: 0.3
      });

      expect(summary.sessionDurationMs).toBe(0);
      expect(summary.totalEnergyChargedKwh).toBe(0);
      expect(summary.gridImportKwh).toBe(0);
      expect(summary.solarEnergyUsedKwh).toBe(0);
      expect(summary.averageChargingSpeedAmps).toBe(0);
      expect(summary.ampereFluctuations).toBe(0);
      expect(summary.gridImportCost).toBe(0);
    });
  });

  describe("with a completed charging session", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("computes energy charged as final minus start", () => {
      vi.setSystemTime(new Date("2025-06-01T12:00:00Z"));
      const stats = withSessionStarted(defaultStats);

      vi.setSystemTime(new Date("2025-06-01T13:00:00Z"));
      const summary = computeSessionSummary({
        stats,
        finalChargeEnergyAdded: 7.5,
        finalDailyImport: 0,
        finalVoltage: 230,
        costPerKwh: 0.3
      });

      expect(summary.totalEnergyChargedKwh).toBe(7.5);
    });

    it("computes grid import as final minus start", () => {
      vi.setSystemTime(new Date("2025-06-01T12:00:00Z"));
      const stats = withSessionStarted(defaultStats);

      vi.setSystemTime(new Date("2025-06-01T13:00:00Z"));
      const summary = computeSessionSummary({
        stats,
        finalChargeEnergyAdded: 7.5,
        finalDailyImport: 3.0,
        finalVoltage: 230,
        costPerKwh: 0.3
      });

      expect(summary.gridImportKwh).toBe(3.0);
    });

    it("computes solar energy as total minus grid import, floored at 0", () => {
      vi.setSystemTime(new Date("2025-06-01T12:00:00Z"));
      const stats = withSessionStarted(defaultStats);

      vi.setSystemTime(new Date("2025-06-01T13:00:00Z"));
      const allSolar = computeSessionSummary({
        stats,
        finalChargeEnergyAdded: 7.5,
        finalDailyImport: 0,
        finalVoltage: 230,
        costPerKwh: 0.3
      });
      expect(allSolar.solarEnergyUsedKwh).toBe(7.5);

      const partialSolar = computeSessionSummary({
        stats,
        finalChargeEnergyAdded: 7.5,
        finalDailyImport: 3.0,
        finalVoltage: 230,
        costPerKwh: 0.3
      });
      expect(partialSolar.solarEnergyUsedKwh).toBe(4.5);

      const noSolar = computeSessionSummary({
        stats,
        finalChargeEnergyAdded: 5.0,
        finalDailyImport: 7.0,
        finalVoltage: 230,
        costPerKwh: 0.3
      });
      expect(noSolar.solarEnergyUsedKwh).toBe(0);
    });

    it("calculates session duration from start to now", () => {
      vi.setSystemTime(new Date("2025-06-01T12:00:00Z"));
      const stats = withSessionStarted(defaultStats);

      vi.setSystemTime(new Date("2025-06-01T14:30:00Z"));
      const summary = computeSessionSummary({
        stats,
        finalChargeEnergyAdded: 15,
        finalDailyImport: 5,
        finalVoltage: 230,
        costPerKwh: 0.3
      });

      expect(summary.sessionDurationMs).toBe(9_000_000);
    });

    it("includes fluctuation count in the summary", () => {
      vi.setSystemTime(new Date("2025-06-01T12:00:00Z"));
      const stats = recordFluctuation(recordFluctuation(withSessionStarted(defaultStats)));

      vi.setSystemTime(new Date("2025-06-01T13:00:00Z"));
      const summary = computeSessionSummary({
        stats,
        finalChargeEnergyAdded: 7.5,
        finalDailyImport: 0,
        finalVoltage: 230,
        costPerKwh: 0.3
      });

      expect(summary.ampereFluctuations).toBe(2);
    });

    it("calculates grid import cost as gridImportKwh * costPerKwh", () => {
      vi.setSystemTime(new Date("2025-06-01T12:00:00Z"));
      const stats = withSessionStarted(defaultStats);

      vi.setSystemTime(new Date("2025-06-01T13:00:00Z"));
      const summary = computeSessionSummary({
        stats,
        finalChargeEnergyAdded: 7.5,
        finalDailyImport: 4.0,
        finalVoltage: 230,
        costPerKwh: 0.25
      });

      expect(summary.gridImportCost).toBe(1.0);
    });

    it("calculates average charging speed in amps", () => {
      vi.setSystemTime(new Date("2025-06-01T12:00:00Z"));
      const stats = withSessionStarted(defaultStats);

      // 1 hour session, 7.5 kWh added, 230V
      // speed = (7.5 * 1000) / (230 * 1) = 7500 / 230 ≈ 32.61
      vi.setSystemTime(new Date("2025-06-01T13:00:00Z"));
      const summary = computeSessionSummary({
        stats,
        finalChargeEnergyAdded: 7.5,
        finalDailyImport: 0,
        finalVoltage: 230,
        costPerKwh: 0.3
      });

      expect(summary.averageChargingSpeedAmps).toBeCloseTo(32.61, 1);
    });

    it("returns 0 average speed when duration is 0", () => {
      const stats = withSessionStarted(defaultStats);

      const summary = computeSessionSummary({
        stats,
        finalChargeEnergyAdded: 0,
        finalDailyImport: 0,
        finalVoltage: 230,
        costPerKwh: 0.3
      });

      expect(summary.averageChargingSpeedAmps).toBe(0);
    });

    it("returns 0 average speed when voltage is 0", () => {
      vi.setSystemTime(new Date("2025-06-01T12:00:00Z"));
      const stats = withSessionStarted(defaultStats);

      vi.setSystemTime(new Date("2025-06-01T13:00:00Z"));
      const summary = computeSessionSummary({
        stats,
        finalChargeEnergyAdded: 7.5,
        finalDailyImport: 0,
        finalVoltage: 0,
        costPerKwh: 0.3
      });

      expect(summary.averageChargingSpeedAmps).toBe(0);
    });
  });
});
