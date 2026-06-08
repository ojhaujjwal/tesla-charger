import { describe, it, expect } from "vitest";
import {
  createInitialChargingControlState,
  createInitialChargingSessionStats,
  _Idle,
  _Starting,
  _Charging,
  _ChangingAmpere,
  _Stopping,
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
    const result = requestChargeStart(_Idle({ status: "Idle" }), 16, defaultConfig);

    expect(result.state).toStrictEqual({ status: "Starting", targetAmpere: 16 });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toStrictEqual({ type: "ChargingStarted" });
    expect(result.waitSeconds).toBe(42);
    expect(result.recordFluctuation).toBe(true);
  });

  it("caps target at 32", () => {
    const result = requestChargeStart(_Idle({ status: "Idle" }), 40, defaultConfig);

    expect(result.state).toStrictEqual({ status: "Starting", targetAmpere: 32 });
  });
});

describe("requestChargeStop", () => {
  it("transitions Charging to Stopping with stop wait", () => {
    const result = requestChargeStop(_Charging({ status: "Charging", ampere: 10 }), defaultConfig);

    expect(result.state).toStrictEqual({ status: "Stopping" });
    expect(result.waitSeconds).toBe(10);
  });

  it("transitions Starting to Stopping", () => {
    const result = requestChargeStop(_Starting({ status: "Starting", targetAmpere: 16 }), defaultConfig);

    expect(result.state).toStrictEqual({ status: "Stopping" });
    expect(result.waitSeconds).toBe(10);
  });

  it("transitions ChangingAmpere to Stopping", () => {
    const result = requestChargeStop(
      _ChangingAmpere({ status: "ChangingAmpere", current: 6, target: 16 }),
      defaultConfig
    );

    expect(result.state).toStrictEqual({ status: "Stopping" });
    expect(result.waitSeconds).toBe(10);
  });
});

describe("requestAmpereChange", () => {
  it("transitions Charging to ChangingAmpere, emits event, calculates wait", () => {
    const result = requestAmpereChange(_Charging({ status: "Charging", ampere: 6 }), 16, defaultConfig);

    expect("unchanged" in result).toBe(false);
    if ("unchanged" in result) return;
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
    const result = requestAmpereChange(_Charging({ status: "Charging", ampere: 6 }), 40, defaultConfig);

    expect("unchanged" in result).toBe(false);
    if ("unchanged" in result) return;
    expect(result.state).toStrictEqual({ status: "ChangingAmpere", current: 6, target: 32 });
  });

  it("returns unchanged when target equals current", () => {
    const result = requestAmpereChange(_Charging({ status: "Charging", ampere: 10 }), 10, defaultConfig);

    expect("unchanged" in result).toBe(true);
  });

  it("handles decreasing ampere (ramping down)", () => {
    const result = requestAmpereChange(_Charging({ status: "Charging", ampere: 16 }), 6, defaultConfig);

    expect("unchanged" in result).toBe(false);
    if ("unchanged" in result) return;
    expect(result.state).toStrictEqual({ status: "ChangingAmpere", current: 16, target: 6 });
    expect(result.waitSeconds).toBe(20);
  });
});

describe("completeChargeStart", () => {
  it("transitions Starting to Charging with no events", () => {
    const result = completeChargeStart(_Starting({ status: "Starting", targetAmpere: 16 }));

    expect(result.state).toStrictEqual({ status: "Charging", ampere: 16 });
    expect(result.events).toHaveLength(0);
    expect(result.waitSeconds).toBe(0);
  });
});

describe("completeAmpereChange", () => {
  it("transitions ChangingAmpere to Charging, emits AmpereChangeFinished", () => {
    const result = completeAmpereChange(_ChangingAmpere({ status: "ChangingAmpere", current: 6, target: 16 }));

    expect(result.state).toStrictEqual({ status: "Charging", ampere: 16 });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toStrictEqual({ type: "AmpereChangeFinished", current: 16 });
    expect(result.waitSeconds).toBe(0);
  });
});

describe("completeChargeStop", () => {
  it("transitions Stopping to Idle, emits ChargingStopped", () => {
    const result = completeChargeStop(_Stopping({ status: "Stopping" }));

    expect(result.state).toStrictEqual({ status: "Idle" });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toStrictEqual({ type: "ChargingStopped" });
    expect(result.waitSeconds).toBe(0);
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
