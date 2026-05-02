export type ChargingControlState =
  | { readonly status: "Idle" }
  | { readonly status: "Starting"; readonly targetAmpere: number }
  | { readonly status: "Charging"; readonly ampere: number }
  | { readonly status: "ChangingAmpere"; readonly current: number; readonly target: number }
  | { readonly status: "Stopping" };

export const createInitialChargingControlState = (): ChargingControlState => ({
  status: "Idle"
});

export type ChargingControlEvent =
  | { readonly type: "ChargingStarted" }
  | { readonly type: "ChargingStopped" }
  | { readonly type: "AmpereChangeInitiated"; readonly previous: number; readonly current: number }
  | { readonly type: "AmpereChangeFinished"; readonly current: number };

export type TransitionResult = {
  readonly state: ChargingControlState;
  readonly events: ChargingControlEvent[];
  readonly waitSeconds: number;
  readonly recordFluctuation: boolean;
};

export type ChargingConfig = {
  readonly waitPerAmereInSeconds: number;
  readonly extraWaitOnChargeStartInSeconds: number;
  readonly extraWaitOnChargeStopInSeconds: number;
};

export const requestChargeStart = (
  state: ChargingControlState,
  targetAmpere: number,
  config: ChargingConfig
): TransitionResult => {
  if (state.status !== "Idle") {
    return { state, events: [], waitSeconds: 0, recordFluctuation: false };
  }
  const amp = Math.min(32, targetAmpere);
  const waitSeconds = amp * config.waitPerAmereInSeconds + config.extraWaitOnChargeStartInSeconds;
  return {
    state: { status: "Starting", targetAmpere: amp },
    events: [{ type: "ChargingStarted" }],
    waitSeconds,
    recordFluctuation: true
  };
};

export const requestChargeStop = (
  state: ChargingControlState,
  config: Pick<ChargingConfig, "extraWaitOnChargeStopInSeconds">
): TransitionResult => {
  if (state.status !== "Charging" && state.status !== "Starting" && state.status !== "ChangingAmpere") {
    return { state, events: [], waitSeconds: 0, recordFluctuation: false };
  }
  return {
    state: { status: "Stopping" },
    events: [],
    waitSeconds: config.extraWaitOnChargeStopInSeconds,
    recordFluctuation: false
  };
};

export const requestAmpereChange = (
  state: ChargingControlState,
  targetAmpere: number,
  config: Pick<ChargingConfig, "waitPerAmereInSeconds">
): TransitionResult => {
  if (state.status !== "Charging") {
    return { state, events: [], waitSeconds: 0, recordFluctuation: false };
  }
  const amp = Math.min(32, targetAmpere);
  if (state.ampere === amp) {
    return { state, events: [], waitSeconds: 0, recordFluctuation: false };
  }
  const ampDiff = Math.abs(amp - state.ampere);
  return {
    state: { status: "ChangingAmpere", current: state.ampere, target: amp },
    events: [{ type: "AmpereChangeInitiated", previous: state.ampere, current: amp }],
    waitSeconds: ampDiff * config.waitPerAmereInSeconds,
    recordFluctuation: true
  };
};

export const completeChargeStart = (state: ChargingControlState): TransitionResult => {
  if (state.status !== "Starting") {
    return { state, events: [], waitSeconds: 0, recordFluctuation: false };
  }
  return {
    state: { status: "Charging", ampere: state.targetAmpere },
    events: [],
    waitSeconds: 0,
    recordFluctuation: false
  };
};

export const completeAmpereChange = (state: ChargingControlState): TransitionResult => {
  if (state.status !== "ChangingAmpere") {
    return { state, events: [], waitSeconds: 0, recordFluctuation: false };
  }
  return {
    state: { status: "Charging", ampere: state.target },
    events: [{ type: "AmpereChangeFinished", current: state.target }],
    waitSeconds: 0,
    recordFluctuation: false
  };
};

export const completeChargeStop = (state: ChargingControlState): TransitionResult => {
  if (state.status !== "Stopping") {
    return { state, events: [], waitSeconds: 0, recordFluctuation: false };
  }
  return {
    state: { status: "Idle" },
    events: [{ type: "ChargingStopped" }],
    waitSeconds: 0,
    recordFluctuation: false
  };
};

export const createInitialChargingSessionStats = (): ChargingSessionStats => ({
  ampereFluctuations: 0,
  sessionStartedAt: null,
  chargeEnergyAddedAtStartKwh: 0,
  dailyImportValueAtStart: 0
});

export type ChargingSessionStats = {
  readonly ampereFluctuations: number;
  readonly sessionStartedAt: Date | null;
  readonly chargeEnergyAddedAtStartKwh: number;
  readonly dailyImportValueAtStart: number;
};

export const recordFluctuation = (stats: ChargingSessionStats): ChargingSessionStats => ({
  ...stats,
  ampereFluctuations: stats.ampereFluctuations + 1
});

export const withDailyImportRecorded = (stats: ChargingSessionStats, value: number): ChargingSessionStats => ({
  ...stats,
  dailyImportValueAtStart: value
});

export const withChargeEnergyRecorded = (stats: ChargingSessionStats, value: number): ChargingSessionStats => ({
  ...stats,
  chargeEnergyAddedAtStartKwh: value
});

export const withSessionStarted = (stats: ChargingSessionStats): ChargingSessionStats => ({
  ...stats,
  sessionStartedAt: new Date()
});

export enum AppStatus {
  Pending,
  Running,
  Stopped
}
