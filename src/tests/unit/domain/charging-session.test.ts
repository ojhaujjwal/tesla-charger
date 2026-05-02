import { describe, it, expect } from "vitest";
import {
  createInitialChargingControlState,
  createInitialChargingSessionStats,
  requestChargeStart,
  requestChargeStop,
  requestAmpereChange,
  completeChargeStart,
  completeAmpereChange,
  completeChargeStop,
  recordFluctuation,
  withDailyImportRecorded,
  withChargeEnergyRecorded,
  withSessionStarted
} from "../../../domain/charging-session.js";
const defaultConfig = {
  waitPerAmereInSeconds: 2,
  extraWaitOnChargeStartInSeconds: 10,
  extraWaitOnChargeStopInSeconds: 10
};

describe("requestChargeStart", () => {
  it("transitions Idle to Starting, emits ChargingStarted, calculates wait", () => {
    const result = requestChargeStart({ status: "Idle" }, 16, defaultConfig);

    expect(result.state).toStrictEqual({ status: "Starting", targetAmpere: 16 });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toStrictEqual({ type: "ChargingStarted" });
    expect(result.waitSeconds).toBe(42);
    expect(result.recordFluctuation).toBe(true);
  });

  it("caps target at 32", () => {
    const result = requestChargeStart({ status: "Idle" }, 40, defaultConfig);

    expect(result.state).toStrictEqual({ status: "Starting", targetAmpere: 32 });
  });

  it("returns no-op when already Charging", () => {
    const result = requestChargeStart({ status: "Charging", ampere: 10 }, 16, defaultConfig);

    expect(result.state).toStrictEqual({ status: "Charging", ampere: 10 });
    expect(result.events).toHaveLength(0);
    expect(result.waitSeconds).toBe(0);
    expect(result.recordFluctuation).toBe(false);
  });

  it("returns no-op when already Starting", () => {
    const result = requestChargeStart({ status: "Starting", targetAmpere: 10 }, 16, defaultConfig);

    expect(result.state).toStrictEqual({ status: "Starting", targetAmpere: 10 });
    expect(result.events).toHaveLength(0);
  });

  it("returns no-op when ChangingAmpere", () => {
    const result = requestChargeStart({ status: "ChangingAmpere", current: 6, target: 16 }, 16, defaultConfig);

    expect(result.state).toStrictEqual({ status: "ChangingAmpere", current: 6, target: 16 });
    expect(result.events).toHaveLength(0);
  });

  it("returns no-op when Stopping", () => {
    const result = requestChargeStart({ status: "Stopping" }, 16, defaultConfig);

    expect(result.state).toStrictEqual({ status: "Stopping" });
    expect(result.events).toHaveLength(0);
  });
});

describe("requestChargeStop", () => {
  it("transitions Charging to Stopping with stop wait", () => {
    const result = requestChargeStop({ status: "Charging", ampere: 10 }, defaultConfig);

    expect(result.state).toStrictEqual({ status: "Stopping" });
    expect(result.events).toHaveLength(0);
    expect(result.waitSeconds).toBe(10);
    expect(result.recordFluctuation).toBe(false);
  });

  it("transitions Starting to Stopping", () => {
    const result = requestChargeStop({ status: "Starting", targetAmpere: 16 }, defaultConfig);

    expect(result.state).toStrictEqual({ status: "Stopping" });
    expect(result.waitSeconds).toBe(10);
  });

  it("transitions ChangingAmpere to Stopping", () => {
    const result = requestChargeStop({ status: "ChangingAmpere", current: 6, target: 16 }, defaultConfig);

    expect(result.state).toStrictEqual({ status: "Stopping" });
    expect(result.waitSeconds).toBe(10);
  });

  it("returns no-op when Idle", () => {
    const result = requestChargeStop({ status: "Idle" }, defaultConfig);

    expect(result.state).toStrictEqual({ status: "Idle" });
    expect(result.events).toHaveLength(0);
    expect(result.waitSeconds).toBe(0);
  });

  it("returns no-op when already Stopping", () => {
    const result = requestChargeStop({ status: "Stopping" }, defaultConfig);

    expect(result.state).toStrictEqual({ status: "Stopping" });
    expect(result.events).toHaveLength(0);
  });
});

describe("requestAmpereChange", () => {
  it("transitions Charging to ChangingAmpere, emits event, calculates wait", () => {
    const result = requestAmpereChange({ status: "Charging", ampere: 6 }, 16, defaultConfig);

    expect(result.state).toStrictEqual({ status: "ChangingAmpere", current: 6, target: 16 });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toStrictEqual({
      type: "AmpereChangeInitiated",
      previous: 6,
      current: 16
    });
    expect(result.waitSeconds).toBe(20);
    expect(result.recordFluctuation).toBe(true);
  });

  it("caps target at 32", () => {
    const result = requestAmpereChange({ status: "Charging", ampere: 6 }, 40, defaultConfig);

    expect(result.state).toStrictEqual({ status: "ChangingAmpere", current: 6, target: 32 });
  });

  it("returns no-op when target equals current", () => {
    const result = requestAmpereChange({ status: "Charging", ampere: 10 }, 10, defaultConfig);

    expect(result.state).toStrictEqual({ status: "Charging", ampere: 10 });
    expect(result.events).toHaveLength(0);
    expect(result.waitSeconds).toBe(0);
    expect(result.recordFluctuation).toBe(false);
  });

  it("returns no-op when Idle", () => {
    const result = requestAmpereChange({ status: "Idle" }, 16, defaultConfig);

    expect(result.state).toStrictEqual({ status: "Idle" });
    expect(result.events).toHaveLength(0);
  });

  it("returns no-op when Starting", () => {
    const result = requestAmpereChange({ status: "Starting", targetAmpere: 10 }, 16, defaultConfig);

    expect(result.state).toStrictEqual({ status: "Starting", targetAmpere: 10 });
    expect(result.events).toHaveLength(0);
  });

  it("returns no-op when ChangingAmpere", () => {
    const result = requestAmpereChange({ status: "ChangingAmpere", current: 6, target: 16 }, 20, defaultConfig);

    expect(result.state).toStrictEqual({ status: "ChangingAmpere", current: 6, target: 16 });
    expect(result.events).toHaveLength(0);
  });

  it("returns no-op when Stopping", () => {
    const result = requestAmpereChange({ status: "Stopping" }, 16, defaultConfig);

    expect(result.state).toStrictEqual({ status: "Stopping" });
    expect(result.events).toHaveLength(0);
  });

  it("handles decreasing ampere (ramping down)", () => {
    const result = requestAmpereChange({ status: "Charging", ampere: 16 }, 6, defaultConfig);

    expect(result.state).toStrictEqual({ status: "ChangingAmpere", current: 16, target: 6 });
    expect(result.waitSeconds).toBe(20);
  });
});

describe("completeChargeStart", () => {
  it("transitions Starting to Charging with no events", () => {
    const result = completeChargeStart({ status: "Starting", targetAmpere: 16 });

    expect(result.state).toStrictEqual({ status: "Charging", ampere: 16 });
    expect(result.events).toHaveLength(0);
    expect(result.waitSeconds).toBe(0);
    expect(result.recordFluctuation).toBe(false);
  });

  it("returns no-op when Idle", () => {
    const result = completeChargeStart({ status: "Idle" });

    expect(result.state).toStrictEqual({ status: "Idle" });
    expect(result.events).toHaveLength(0);
  });

  it("returns no-op when Charging", () => {
    const result = completeChargeStart({ status: "Charging", ampere: 10 });

    expect(result.state).toStrictEqual({ status: "Charging", ampere: 10 });
    expect(result.events).toHaveLength(0);
  });

  it("returns no-op when ChangingAmpere", () => {
    const result = completeChargeStart({ status: "ChangingAmpere", current: 6, target: 16 });

    expect(result.state).toStrictEqual({ status: "ChangingAmpere", current: 6, target: 16 });
    expect(result.events).toHaveLength(0);
  });

  it("returns no-op when Stopping", () => {
    const result = completeChargeStart({ status: "Stopping" });

    expect(result.state).toStrictEqual({ status: "Stopping" });
    expect(result.events).toHaveLength(0);
  });
});

describe("completeAmpereChange", () => {
  it("transitions ChangingAmpere to Charging, emits AmpereChangeFinished", () => {
    const result = completeAmpereChange({ status: "ChangingAmpere", current: 6, target: 16 });

    expect(result.state).toStrictEqual({ status: "Charging", ampere: 16 });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toStrictEqual({ type: "AmpereChangeFinished", current: 16 });
    expect(result.waitSeconds).toBe(0);
    expect(result.recordFluctuation).toBe(false);
  });

  it("returns no-op when Idle", () => {
    const result = completeAmpereChange({ status: "Idle" });

    expect(result.state).toStrictEqual({ status: "Idle" });
    expect(result.events).toHaveLength(0);
  });

  it("returns no-op when Charging", () => {
    const result = completeAmpereChange({ status: "Charging", ampere: 10 });

    expect(result.state).toStrictEqual({ status: "Charging", ampere: 10 });
    expect(result.events).toHaveLength(0);
  });

  it("returns no-op when Starting", () => {
    const result = completeAmpereChange({ status: "Starting", targetAmpere: 16 });

    expect(result.state).toStrictEqual({ status: "Starting", targetAmpere: 16 });
    expect(result.events).toHaveLength(0);
  });

  it("returns no-op when Stopping", () => {
    const result = completeAmpereChange({ status: "Stopping" });

    expect(result.state).toStrictEqual({ status: "Stopping" });
    expect(result.events).toHaveLength(0);
  });
});

describe("completeChargeStop", () => {
  it("transitions Stopping to Idle, emits ChargingStopped", () => {
    const result = completeChargeStop({ status: "Stopping" });

    expect(result.state).toStrictEqual({ status: "Idle" });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toStrictEqual({ type: "ChargingStopped" });
    expect(result.waitSeconds).toBe(0);
    expect(result.recordFluctuation).toBe(false);
  });

  it("returns no-op when Idle", () => {
    const result = completeChargeStop({ status: "Idle" });

    expect(result.state).toStrictEqual({ status: "Idle" });
    expect(result.events).toHaveLength(0);
  });

  it("returns no-op when Charging", () => {
    const result = completeChargeStop({ status: "Charging", ampere: 10 });

    expect(result.state).toStrictEqual({ status: "Charging", ampere: 10 });
    expect(result.events).toHaveLength(0);
  });

  it("returns no-op when Starting", () => {
    const result = completeChargeStop({ status: "Starting", targetAmpere: 16 });

    expect(result.state).toStrictEqual({ status: "Starting", targetAmpere: 16 });
    expect(result.events).toHaveLength(0);
  });

  it("returns no-op when ChangingAmpere", () => {
    const result = completeChargeStop({ status: "ChangingAmpere", current: 6, target: 16 });

    expect(result.state).toStrictEqual({ status: "ChangingAmpere", current: 6, target: 16 });
    expect(result.events).toHaveLength(0);
  });
});

describe("initial state", () => {
  it("creates Idle state", () => {
    const state = createInitialChargingControlState();
    expect(state).toStrictEqual({ status: "Idle" });
  });
});

describe("ChargingSessionStats", () => {
  it("starts with zeroed counters and no session", () => {
    const stats = createInitialChargingSessionStats();

    expect(stats.ampereFluctuations).toBe(0);
    expect(stats.sessionStartedAt).toBeNull();
    expect(stats.chargeEnergyAddedAtStartKwh).toBe(0);
    expect(stats.dailyImportValueAtStart).toBe(0);
  });

  describe("when fluctuation is recorded", () => {
    it("increments fluctuation count", () => {
      const stats = createInitialChargingSessionStats();
      const next = recordFluctuation(stats);

      expect(next.ampereFluctuations).toBe(1);
    });

    it("increments from existing count", () => {
      const stats = recordFluctuation(createInitialChargingSessionStats());
      const twice = recordFluctuation(stats);

      expect(twice.ampereFluctuations).toBe(2);
    });
  });

  describe("when daily import is recorded", () => {
    it("stores the value at session start", () => {
      const stats = createInitialChargingSessionStats();
      const next = withDailyImportRecorded(stats, 5.5);

      expect(next.dailyImportValueAtStart).toBe(5.5);
    });

    it("overwrites previous value", () => {
      const stats = withDailyImportRecorded(createInitialChargingSessionStats(), 2.0);
      const next = withDailyImportRecorded(stats, 3.5);

      expect(next.dailyImportValueAtStart).toBe(3.5);
    });
  });

  describe("when charge energy is recorded", () => {
    it("stores the energy value at session start", () => {
      const stats = createInitialChargingSessionStats();
      const next = withChargeEnergyRecorded(stats, 10.0);

      expect(next.chargeEnergyAddedAtStartKwh).toBe(10.0);
    });
  });

  describe("when session starts", () => {
    it("records the start timestamp", () => {
      const stats = createInitialChargingSessionStats();
      const next = withSessionStarted(stats);

      expect(next.sessionStartedAt).toBeInstanceOf(Date);
    });
  });
});
