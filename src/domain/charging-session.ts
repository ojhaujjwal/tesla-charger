import { Brand } from "effect";

// Branded state variants — each carries its status as a phantom type tag.
// At runtime these are plain objects (e.g. { status: "Idle" }).
// We brand each variant individually so that specific-variant fields
// (targetAmpere, ampere, etc.) are accessible after narrowing.
export type IdleState = Brand.Branded<{ readonly status: "Idle" }, "Idle">;
export type StartingState = Brand.Branded<{ readonly status: "Starting"; readonly targetAmpere: number }, "Starting">;
export type ChargingState = Brand.Branded<{ readonly status: "Charging"; readonly ampere: number }, "Charging">;
export type ChangingAmpereState = Brand.Branded<
  { readonly status: "ChangingAmpere"; readonly current: number; readonly target: number },
  "ChangingAmpere"
>;
export type StoppingState = Brand.Branded<{ readonly status: "Stopping" }, "Stopping">;

// ChargingControlState is the branded union — every value flowing through
// the system carries its status as a phantom type tag.  Callers read from
// Ref and switch directly on .status with no separate classify step.
export type ChargingControlState = IdleState | StartingState | ChargingState | ChangingAmpereState | StoppingState;

export const createInitialChargingControlState = (): IdleState => _Idle({ status: "Idle" });

export type ChargingControlEvent =
  | { readonly type: "ChargingStarted" }
  | { readonly type: "ChargingStopped" }
  | { readonly type: "AmpereChangeInitiated"; readonly previous: number; readonly current: number }
  | { readonly type: "AmpereChangeFinished"; readonly current: number };

export type ChargingConfig = {
  readonly waitPerAmereInSeconds: number;
  readonly extraWaitOnChargeStartInSeconds: number;
  readonly extraWaitOnChargeStopInSeconds: number;
};

// Constructor instances (one per variant)
export const _Idle = Brand.nominal<IdleState>();
export const _Starting = Brand.nominal<StartingState>();
export const _Charging = Brand.nominal<ChargingState>();
export const _ChangingAmpere = Brand.nominal<ChangingAmpereState>();
export const _Stopping = Brand.nominal<StoppingState>();

// --- Transition: Idle → Starting ---
export type StartResult = {
  readonly state: StartingState;
  readonly events: readonly [ChargingControlEvent];
  readonly waitSeconds: number;
  readonly recordFluctuation: true;
};

export const requestChargeStart = (state: IdleState, targetAmpere: number, config: ChargingConfig): StartResult => {
  const amp = Math.min(32, targetAmpere);
  const waitSeconds = amp * config.waitPerAmereInSeconds + config.extraWaitOnChargeStartInSeconds;
  return {
    state: _Starting({ status: "Starting", targetAmpere: amp }),
    events: [{ type: "ChargingStarted" }],
    waitSeconds,
    recordFluctuation: true
  };
};

// --- Transition: Starting → Charging ---
export const completeChargeStart = (
  state: StartingState
): { readonly state: ChargingState; readonly events: readonly []; readonly waitSeconds: 0 } => {
  const target = state.targetAmpere;
  return {
    state: _Charging({ status: "Charging", ampere: target }),
    events: [],
    waitSeconds: 0
  };
};

// --- Transition: Charging → ChangingAmpere ---
export type AmpereChangeResult =
  | {
      readonly state: ChangingAmpereState;
      readonly events: readonly [ChargingControlEvent];
      readonly waitSeconds: number;
      readonly recordFluctuation: true;
    }
  | { readonly state: ChargingState; readonly unchanged: true };

export const requestAmpereChange = (
  state: ChargingState,
  targetAmpere: number,
  config: Pick<ChargingConfig, "waitPerAmereInSeconds">
): AmpereChangeResult => {
  const current = state.ampere;
  const amp = Math.min(32, targetAmpere);
  if (current === amp) return { state, unchanged: true };
  const ampDiff = Math.abs(amp - current);
  return {
    state: _ChangingAmpere({ status: "ChangingAmpere", current, target: amp }),
    events: [{ type: "AmpereChangeInitiated" as const, previous: current, current: amp }],
    waitSeconds: ampDiff * config.waitPerAmereInSeconds,
    recordFluctuation: true
  };
};

// --- Transition: ChangingAmpere → Charging ---
export const completeAmpereChange = (
  state: ChangingAmpereState
): { readonly state: ChargingState; readonly events: readonly [ChargingControlEvent]; readonly waitSeconds: 0 } => {
  const target = state.target;
  return {
    state: _Charging({ status: "Charging", ampere: target }),
    events: [{ type: "AmpereChangeFinished" as const, current: target }],
    waitSeconds: 0
  };
};

// --- Transition: active state → Stopping ---
export type ActiveState = StartingState | ChargingState | ChangingAmpereState;

export const requestChargeStop = (
  _state: ActiveState,
  config: Pick<ChargingConfig, "extraWaitOnChargeStopInSeconds">
): { readonly state: StoppingState; readonly waitSeconds: number } => {
  return {
    state: _Stopping({ status: "Stopping" }),
    waitSeconds: config.extraWaitOnChargeStopInSeconds
  };
};

// --- Transition: Stopping → Idle ---
export const completeChargeStop = (
  _state: StoppingState
): { readonly state: IdleState; readonly events: readonly [ChargingControlEvent]; readonly waitSeconds: 0 } => {
  return {
    state: _Idle({ status: "Idle" }),
    events: [{ type: "ChargingStopped" as const }],
    waitSeconds: 0
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
