import { describe, it, expect } from "vitest";
import { calculateRampUpWaitSeconds } from "../../../domain/timing.js";

const defaultConfig = {
  waitPerAmereInSeconds: 2,
  extraWaitOnChargeStartInSeconds: 10
};

describe("calculateRampUpWaitSeconds", () => {
  it("equals ampDifference * waitPerAmere when not a charging start", () => {
    const wait = calculateRampUpWaitSeconds({
      ampDifference: 10,
      isChargingStart: false,
      config: defaultConfig
    });

    expect(wait).toBe(20);
  });

  it("adds extra wait on charge start", () => {
    const wait = calculateRampUpWaitSeconds({
      ampDifference: 10,
      isChargingStart: true,
      config: defaultConfig
    });

    expect(wait).toBe(30);
  });

  it("handles 0 amp difference correctly", () => {
    const wait = calculateRampUpWaitSeconds({
      ampDifference: 0,
      isChargingStart: false,
      config: defaultConfig
    });

    expect(wait).toBe(0);
  });

  it("handles 0 amp difference with charge start", () => {
    const wait = calculateRampUpWaitSeconds({
      ampDifference: 0,
      isChargingStart: true,
      config: defaultConfig
    });

    expect(wait).toBe(10);
  });

  it("works with custom timing config values", () => {
    const wait = calculateRampUpWaitSeconds({
      ampDifference: 5,
      isChargingStart: false,
      config: {
        waitPerAmereInSeconds: 5,
        extraWaitOnChargeStartInSeconds: 20
      }
    });

    expect(wait).toBe(25);
  });

  it("handles 1 amp difference", () => {
    const wait = calculateRampUpWaitSeconds({
      ampDifference: 1,
      isChargingStart: false,
      config: defaultConfig
    });

    expect(wait).toBe(2);
  });
});
