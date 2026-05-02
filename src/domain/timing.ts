import type { ChargingConfig } from "./charging-session.js";

export const calculateRampUpWaitSeconds = (params: {
  readonly ampDifference: number;
  readonly isChargingStart: boolean;
  readonly config: Pick<ChargingConfig, "waitPerAmereInSeconds" | "extraWaitOnChargeStartInSeconds">;
}): number => {
  const base = params.ampDifference * params.config.waitPerAmereInSeconds;
  return params.isChargingStart ? base + params.config.extraWaitOnChargeStartInSeconds : base;
};
