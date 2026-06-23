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
import { Ampere, KiloWattHours as KWh } from "../../../domain/brands.js";
const defaultConfig = {
  waitPerAmereInSeconds: 2,
  extraWaitOnChargeStartInSeconds: 10,
  extraWaitOnChargeStopInSeconds: 10
};

describe("requestChargeStart", () => {
  it("transitions Idle to Starting, emits ChargingStarted, calculates wait", () => {
    const result = requestChargeStart(_Idle({ status: "Idle" }), Ampere(16), defaultConfig);

    expect(result.state).toStrictEqual({ status: "Starting", targetAmpere: Ampere(16) });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toStrictEqual({ type: "ChargingStarted" });
    expect(result.waitSeconds).toBe(42);
  });

  it("caps target at 32", () => {
    const result = requestChargeStart(_Idle({ status: "Idle" }), Ampere(32), defaultConfig);

    expect(result.state).toStrictEqual({ status: "Starting", targetAmpere: Ampere(32) });
  });
});

describe("requestChargeStop", () => {
  it("transitions Charging to Stopping with stop wait", () => {
    const result = requestChargeStop(_Charging({ status: "Charging", ampere: Ampere(10) }), defaultConfig);

    expect(result.state).toStrictEqual({ status: "Stopping" });
    expect(result.waitSeconds).toBe(10);
  });

  it("transitions Starting to Stopping", () => {
    const result = requestChargeStop(_Starting({ status: "Starting", targetAmpere: Ampere(16) }), defaultConfig);

    expect(result.state).toStrictEqual({ status: "Stopping" });
    expect(result.waitSeconds).toBe(10);
  });

  it("transitions ChangingAmpere to Stopping", () => {
    const result = requestChargeStop(
      _ChangingAmpere({ status: "ChangingAmpere", current: Ampere(6), target: Ampere(16) }),
      defaultConfig
    );

    expect(result.state).toStrictEqual({ status: "Stopping" });
    expect(result.waitSeconds).toBe(10);
  });
});

describe("requestAmpereChange", () => {
  it("transitions Charging to ChangingAmpere, emits event, calculates wait", () => {
    const result = requestAmpereChange(_Charging({ status: "Charging", ampere: Ampere(6) }), Ampere(16), defaultConfig);

    expect("unchanged" in result).toBe(false);
    if ("unchanged" in result) return;
    expect(result.state).toStrictEqual({ status: "ChangingAmpere", current: Ampere(6), target: Ampere(16) });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toStrictEqual({
      type: "AmpereChangeInitiated",
      previous: Ampere(6),
      current: Ampere(16)
    });
    expect(result.waitSeconds).toBe(20);
  });

  it("caps target at 32", () => {
    const result = requestAmpereChange(_Charging({ status: "Charging", ampere: Ampere(6) }), Ampere(32), defaultConfig);

    expect("unchanged" in result).toBe(false);
    if ("unchanged" in result) return;
    expect(result.state).toStrictEqual({ status: "ChangingAmpere", current: Ampere(6), target: Ampere(32) });
  });

  it("returns unchanged when target equals current", () => {
    const result = requestAmpereChange(
      _Charging({ status: "Charging", ampere: Ampere(10) }),
      Ampere(10),
      defaultConfig
    );

    expect("unchanged" in result).toBe(true);
  });

  it("handles decreasing ampere (ramping down)", () => {
    const result = requestAmpereChange(_Charging({ status: "Charging", ampere: Ampere(16) }), Ampere(6), defaultConfig);

    expect("unchanged" in result).toBe(false);
    if ("unchanged" in result) return;
    expect(result.state).toStrictEqual({ status: "ChangingAmpere", current: Ampere(16), target: Ampere(6) });
    expect(result.waitSeconds).toBe(20);
  });
});

describe("completeChargeStart", () => {
  it("transitions Starting to Charging with no events", () => {
    const result = completeChargeStart(_Starting({ status: "Starting", targetAmpere: Ampere(16) }));

    expect(result.state).toStrictEqual({ status: "Charging", ampere: Ampere(16) });
    expect(result.events).toHaveLength(0);
    expect(result.waitSeconds).toBe(0);
  });
});

describe("completeAmpereChange", () => {
  it("transitions ChangingAmpere to Charging, emits AmpereChangeFinished", () => {
    const result = completeAmpereChange(
      _ChangingAmpere({ status: "ChangingAmpere", current: Ampere(6), target: Ampere(16) })
    );

    expect(result.state).toStrictEqual({ status: "Charging", ampere: Ampere(16) });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toStrictEqual({ type: "AmpereChangeFinished", current: Ampere(16) });
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
      const next = withDailyImportRecorded(stats, KWh(5.5));

      expect(next.dailyImportValueAtStart).toBe(KWh(5.5));
    });

    it("overwrites previous value", () => {
      const stats = withDailyImportRecorded(createInitialChargingSessionStats(), KWh(2.0));
      const next = withDailyImportRecorded(stats, KWh(3.5));

      expect(next.dailyImportValueAtStart).toBe(KWh(3.5));
    });
  });

  describe("when charge energy is recorded", () => {
    it("stores the energy value at session start", () => {
      const stats = createInitialChargingSessionStats();
      const next = withChargeEnergyRecorded(stats, KWh(10.0));

      expect(next.chargeEnergyAddedAtStartKwh).toBe(KWh(10.0));
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
