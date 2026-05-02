# Refactor app.ts with Domain-Driven Design

## Overview

Break `src/app.ts` (461 lines) into domain (pure, no Effect) and application (Effect + services) layers, following Domain-Driven Design principles. Split the monolithic `ChargingState` into two concerns: `ChargingControlState` (used to control the car: start, stop, change ampere) and `ChargingSessionStats` (used to track events for computing the session summary). The `App` tag's public interface (`start()`/`stop()`) remains unchanged, so `app.test.ts` continues to function as functional/integration tests with zero to minimal changes. Remove the unused `lastCommandAt` field.

## Background

`app.ts` currently mixes orchestration, state management, fiber lifecycle, charging logic, error handling, and session computation in one 461-line function. Mutable state is managed via closure variables instead of Effect's `Ref`. `ChargingState` conflates two concerns — actual charge-control state (`running`, `ampere`) and session-tracking stats (`sessionStartedAt`, `chargeEnergyAddedAtStartKwh`, `ampereFluctuations`, `dailyImportValueAtStart`). `lastCommandAt` is write-only dead code.

## Requirements

- [ ] Split `ChargingState` into `ChargingControlState` and `ChargingSessionStats`, remove `lastCommandAt`
- [ ] Extract domain types and pure functions into `src/domain/` (no Effect dependency)
- [ ] Extract application Effect functions into `src/application/` (depends on domain + services)
- [ ] `app.ts` reduced to thin orchestrator (~120 lines) using two `Effect.Ref`s for state
- [ ] `App` tag interface unchanged (`start()`/`stop()` methods with same error types)
- [ ] `AppLayer` factory signature unchanged
- [ ] `app.test.ts` passes with minimal changes (import path updates only)
- [ ] `SessionSummary` type moved to domain, re-exported by `event-logger/types.ts`

## Tasks

- [ ] **Task 1**: Create domain modules and update event-logger re-export
- [ ] **Task 2**: Create application modules
- [ ] **Task 3**: Rewrite app.ts to use domain + application modules

**Note**: Each task must be atomic — each task leaves the codebase in a working, compilable state.

## Implementation Details

### Task 1: Create domain modules and update event-logger re-export

Create pure domain modules (no Effect dependency) and update backward-compatible re-exports.

**1a. Create `src/domain/charging-session.ts`** (~80 lines)

Two separate types replace the old monolithic `ChargingState`. `AppStatus` and `TimingConfig` move here too. All transition functions are pure (immutable, no side effects):

```typescript
// ── Charging control state ──
// Used to start/stop/change the car's charging speed.

export type ChargingControlState = {
  readonly running: boolean;
  readonly ampere: number;
};

export const createInitialChargingControlState = (): ChargingControlState => ({
  running: false,
  ampere: 0
});

// ── Session stats ──
// Used to track events for computing the session summary.

export type ChargingSessionStats = {
  readonly ampereFluctuations: number;
  readonly sessionStartedAt: Date | null;
  readonly chargeEnergyAddedAtStartKwh: number;
  readonly dailyImportValueAtStart: number;
};

export const createInitialChargingSessionStats = (): ChargingSessionStats => ({
  ampereFluctuations: 0,
  sessionStartedAt: null,
  chargeEnergyAddedAtStartKwh: 0,
  dailyImportValueAtStart: 0
});

// ── App lifecycle enum ──

export enum AppStatus { Pending, Running, Stopped }

// ── Predicates (pure boolean checks) ──

export const shouldStartCharging = (ampere: number, isRunning: boolean): boolean =>
  ampere >= 3 && !isRunning;

export const shouldStopCharging = (ampere: number, isRunning: boolean): boolean =>
  ampere < 3 && isRunning;

export const needsAmpereChange = (currentAmpere: number, targetAmpere: number): boolean =>
  currentAmpere !== targetAmpere;

// ── Control state transitions ──

export const withChargeStarted = (state: ChargingControlState): ChargingControlState => ({
  ...state,
  running: true
});

export const withChargeStopped = (state: ChargingControlState): ChargingControlState => ({
  ampere: 0,
  running: false
});

export const withAmpereSet = (state: ChargingControlState, ampere: number): ChargingControlState => ({
  ...state,
  ampere
});

// ── Session stats transitions ──

export const recordFluctuation = (stats: ChargingSessionStats): ChargingSessionStats => ({
  ...stats,
  ampereFluctuations: stats.ampereFluctuations + 1
});

export const withDailyImportRecorded = (
  stats: ChargingSessionStats,
  value: number
): ChargingSessionStats => ({
  ...stats,
  dailyImportValueAtStart: value
});

export const withChargeEnergyRecorded = (
  stats: ChargingSessionStats,
  value: number
): ChargingSessionStats => ({
  ...stats,
  chargeEnergyAddedAtStartKwh: value
});

export const withSessionStarted = (stats: ChargingSessionStats): ChargingSessionStats => ({
  ...stats,
  sessionStartedAt: new Date()
});

// ── TimingConfig (moved from app.ts) ──

export type TimingConfig = {
  readonly syncIntervalInMs: number;
  readonly vehicleAwakeningTimeInMs: number;
  readonly inactivityTimeInSeconds: number;
  readonly waitPerAmereInSeconds: number;
  readonly extraWaitOnChargeStartInSeconds: number;
  readonly extraWaitOnChargeStopInSeconds: number;
  readonly maxRuntimeHours?: number;
};
```

**1b. Create `src/domain/session-summary.ts`** (~45 lines)

Move `SessionSummary` type from `event-logger/types.ts` and add pure computation. Uses `ChargingSessionStats` instead of the old monolithic `ChargingState`:

```typescript
import type { ChargingSessionStats } from "./charging-session.js";

export type SessionSummary = {
  readonly sessionDurationMs: number;
  readonly totalEnergyChargedKwh: number;
  readonly gridImportKwh: number;
  readonly solarEnergyUsedKwh: number;
  readonly averageChargingSpeedAmps: number;
  readonly ampereFluctuations: number;
  readonly gridImportCost: number;
};

export const computeSessionSummary = (params: {
  readonly stats: ChargingSessionStats;
  readonly finalChargeEnergyAdded: number;
  readonly finalDailyImport: number;
  readonly finalVoltage: number;
  readonly costPerKwh: number;
}): SessionSummary => {
  const sessionDurationMs = params.stats.sessionStartedAt
    ? Date.now() - params.stats.sessionStartedAt.getTime()
    : 0;

  const totalEnergyChargedKwh = params.finalChargeEnergyAdded - params.stats.chargeEnergyAddedAtStartKwh;
  const gridImportKwh = params.finalDailyImport - params.stats.dailyImportValueAtStart;
  const solarEnergyUsedKwh = Math.max(0, totalEnergyChargedKwh - gridImportKwh);

  const sessionDurationHours = sessionDurationMs / 3_600_000;
  const averageChargingSpeedAmps =
    sessionDurationHours > 0 && params.finalVoltage > 0
      ? (totalEnergyChargedKwh * 1000) / (params.finalVoltage * sessionDurationHours)
      : 0;

  const gridImportCost = gridImportKwh * params.costPerKwh;

  return {
    sessionDurationMs,
    totalEnergyChargedKwh,
    gridImportKwh,
    solarEnergyUsedKwh,
    averageChargingSpeedAmps,
    ampereFluctuations: params.stats.ampereFluctuations,
    gridImportCost
  };
};
```

**1c. Create `src/domain/timing.ts`** (~20 lines)

```typescript
import type { TimingConfig } from "./charging-session.js";

export const calculateRampUpWaitSeconds = (params: {
  readonly ampDifference: number;
  readonly isChargingStart: boolean;
  readonly config: Pick<TimingConfig, "waitPerAmereInSeconds" | "extraWaitOnChargeStartInSeconds">;
}): number => {
  const base = params.ampDifference * params.config.waitPerAmereInSeconds;
  return params.isChargingStart ? base + params.config.extraWaitOnChargeStartInSeconds : base;
};
```

**1d. Update `src/event-logger/types.ts`**

Replace inline `SessionSummary` type with re-export from domain:

```typescript
import type { Effect } from "effect";

export type { SessionSummary } from "../../domain/session-summary.js";

export type IEventLogger = {
  onSetAmpere: (ampere: number) => Effect.Effect<void>;
  onNoAmpereChange: (currentChargingAmpere: number) => Effect.Effect<void>;
  onSessionEnd: (summary: import("../../domain/session-summary.js").SessionSummary) => Effect.Effect<void>;
};
```

### Task 2: Create application modules

Create Effect-based application functions in `src/application/`. These import from domain modules and declare service dependencies via `yield*`. All functions are standalone exports (not service classes).

**2a. Create `src/application/production-guard.ts`** (~30 lines)

Extracts `waitAndWatchoutForSuddenDropInProduction` from app.ts:

```typescript
import { DataAdapter } from "../data-adapter/types.js";
import { AbruptProductionDropError } from "../errors/abrupt-production-drop.error.js";
import { Duration, Effect, Schedule } from "effect";

export const watchForProductionDrop = (
  currentProductionAtStart: number,
  timeInSeconds: number
): Effect.Effect<void, AbruptProductionDropError, DataAdapter> =>
  Effect.race(
    Effect.void.pipe(Effect.delay(Duration.seconds(timeInSeconds))),
    Effect.repeat(
      Effect.gen(function* () {
        const { current_production: currentProduction, import_from_grid: importingFromGrid } =
          yield* DataAdapter.queryLatestValues(["current_production", "import_from_grid"]);
        yield* Effect.logDebug("watching for sudden drop in production", {
          currentProduction,
          currentProductionAtStart,
          importingFromGrid
        });
        if (importingFromGrid > 0) {
          return yield* new AbruptProductionDropError({
            initialProduction: currentProductionAtStart,
            currentProduction
          });
        }
      }),
      Schedule.fixed(Duration.seconds(4))
    )
  );
```

**2b. Create `src/application/charge-commands.ts`** (~35 lines)

Thin wrappers around TeslaClient commands with dry-run support. No state mutation — these are pure command-executors:

```typescript
import { TeslaClient } from "../tesla-client/index.js";
import { Effect } from "effect";

export const startCharging = (
  isDryRun: boolean
): Effect.Effect<void, never, TeslaClient> =>
  Effect.gen(function* () {
    if (isDryRun) return yield* Effect.log("Starting charging");
    return yield* TeslaClient.startCharging();
  });

export const stopCharging = (
  isDryRun: boolean
): Effect.Effect<void, never, TeslaClient> =>
  Effect.gen(function* () {
    if (isDryRun) return yield* Effect.log("Stopping charging");
    return yield* TeslaClient.stopCharging();
  });

export const setChargingAmpere = (
  isDryRun: boolean,
  ampere: number
): Effect.Effect<void, never, TeslaClient> =>
  Effect.gen(function* () {
    if (isDryRun) return yield* Effect.log(`Setting ampere to ${ampere}`);
    return yield* TeslaClient.setAmpere(ampere);
  });
```

**2c. Create `src/application/charge-verifier.ts`** (~30 lines)

Extracts `checkIfCorrectlyCharging`. Takes only `ChargingControlState` (the splits's control half) as a plain value since it only reads:

```typescript
import { DataAdapter } from "../data-adapter/types.js";
import { BatteryStateManager } from "../battery-state-manager.js";
import type { ChargingControlState } from "../domain/charging-session.js";
import { Effect } from "effect";

export const verifyCharging = (
  controlState: ChargingControlState,
  batteryStateManager: BatteryStateManager,
  onBatteryComplete: Effect.Effect<void>
): Effect.Effect<void, never, DataAdapter> =>
  Effect.gen(function* () {
    const { current_load: currentLoad, voltage } = yield* DataAdapter.queryLatestValues([
      "current_load",
      "voltage"
    ]);
    const currentLoadAmpere = currentLoad / voltage;

    if (controlState.ampere > 0 && controlState.running && currentLoadAmpere < controlState.ampere) {
      yield* Effect.logDebug("Load power not as expected", {
        currentLoad,
        voltage,
        expectedAmpere: controlState.ampere
      });
    }

    const batteryState = batteryStateManager.get();
    if (batteryState && batteryState.batteryLevel >= batteryState.chargeLimitSoc) {
      yield* Effect.log("Charge complete - battery level reached charge limit", {
        batteryLevel: batteryState.batteryLevel,
        chargeLimitSoc: batteryState.chargeLimitSoc
      });
      yield* onBatteryComplete;
    }
  });
```

**2d. Create `src/application/ampere-sync.ts`** (~80 lines)

Extracts `syncAmpere`. Takes two Refs — one for control state, one for session stats — since it reads control fields and writes to both:

```typescript
import { DataAdapter } from "../data-adapter/types.js";
import { TeslaClient } from "../tesla-client/index.js";
import { AbruptProductionDropError } from "../errors/abrupt-production-drop.error.js";
import type { IEventLogger } from "../event-logger/types.js";
import type { TeslaChargerEvent } from "../events.js";
import type { ChargingControlState, ChargingSessionStats, TimingConfig } from "../domain/charging-session.js";
import {
  shouldStartCharging, shouldStopCharging, needsAmpereChange,
  withChargeStarted, withChargeStopped, withAmpereSet,
  recordFluctuation
} from "../domain/charging-session.js";
import { calculateRampUpWaitSeconds } from "../domain/timing.js";
import * as ChargeCommands from "./charge-commands.js";
import * as ProductionGuard from "./production-guard.js";
import { Duration, Effect, PubSub, Ref } from "effect";

export const syncTargetAmpere = (
  targetAmpere: number,
  controlRef: Ref.Ref<ChargingControlState>,
  statsRef: Ref.Ref<ChargingSessionStats>,
  config: TimingConfig,
  isDryRun: boolean,
  eventLogger: IEventLogger,
  pubSub: PubSub.PubSub<TeslaChargerEvent>
): Effect.Effect<
  void,
  AbruptProductionDropError,
  TeslaClient | DataAdapter
> =>
  Effect.gen(function* () {
    const controlState = yield* Ref.get(controlRef);
    const amp = Math.min(32, targetAmpere);
    const { current_production: currentProductionAtStart } =
      yield* DataAdapter.queryLatestValues(["current_production"]);

    if (shouldStopCharging(amp, controlState.running)) {
      yield* ChargeCommands.stopCharging(isDryRun);
      yield* Effect.sleep(Duration.seconds(config.extraWaitOnChargeStopInSeconds));
      yield* Ref.set(controlRef, withChargeStopped(controlState));
      return;
    }
    if (!controlState.running && amp < 3) return; // not running, nothing to start

    let newControl = controlState;
    const isStarting = shouldStartCharging(amp, controlState.running);
    if (isStarting) {
      yield* ChargeCommands.startCharging(isDryRun);
      newControl = withChargeStarted(newControl);
    }

    if (needsAmpereChange(newControl.ampere, amp)) {
      const previousAmpere = newControl.ampere;
      newControl = withAmpereSet(newControl, amp);
      yield* Ref.update(statsRef, recordFluctuation);

      yield* eventLogger.onSetAmpere(amp);
      yield* ChargeCommands.setChargingAmpere(isDryRun, amp);
      yield* PubSub.publish(pubSub, { _tag: "AmpereChanged" as const, previous: previousAmpere, current: amp });

      const ampDifference = amp - previousAmpere;
      const waitTime = calculateRampUpWaitSeconds({
        ampDifference: Math.abs(ampDifference),
        isChargingStart: isStarting,
        config
      });

      if (ampDifference > 0) {
        yield* ProductionGuard.watchForProductionDrop(currentProductionAtStart, waitTime);
      } else {
        yield* Effect.sleep(Duration.seconds(waitTime));
      }

      yield* Ref.set(controlRef, newControl);
    } else {
      yield* eventLogger.onNoAmpereChange(amp);
    }
  });
```

**2e. Create `src/application/charge-sync-loop.ts`** (~70 lines)

Extracts `syncChargingRateBasedOnExcess` with all retry/error handling. Takes two Refs (passes them through to sub-functions). Reads controlRef to get current state for the controller, reads it again before calling verifyCharging:

```typescript
import { ChargingSpeedController, type InadequateDataToDetermineSpeedError } from "../charging-speed-controller/types.js";
import { TeslaClient } from "../tesla-client/index.js";
import { DataAdapter } from "../data-adapter/types.js";
import { BatteryStateManager } from "../battery-state-manager.js";
import { VehicleNotWakingUpError } from "../errors/vehicle-not-waking-up.error.js";
import { AbruptProductionDropError } from "../errors/abrupt-production-drop.error.js";
import type { IEventLogger } from "../event-logger/types.js";
import type { TeslaChargerEvent } from "../events.js";
import type { ChargingControlState, ChargingSessionStats, TimingConfig } from "../domain/charging-session.js";
import { memoryUsageMB } from "../memory-usage.js";
import * as AmpereSync from "./ampere-sync.js";
import * as ChargeVerifier from "./charge-verifier.js";
import { Duration, Effect, PubSub, Ref } from "effect";

export const runChargingSyncLoop = (
  chargingSpeedController: ChargingSpeedController,
  controlRef: Ref.Ref<ChargingControlState>,
  statsRef: Ref.Ref<ChargingSessionStats>,
  config: TimingConfig,
  isDryRun: boolean,
  eventLogger: IEventLogger,
  pubSub: PubSub.PubSub<TeslaChargerEvent>,
  batteryStateManager: BatteryStateManager,
  onBatteryComplete: Effect.Effect<void>
): Effect.Effect<
  void,
  | InadequateDataToDetermineSpeedError
  | AbruptProductionDropError
  | VehicleNotWakingUpError,
  TeslaClient | DataAdapter | ChargingSpeedController
> => {
  const syncBody = Effect.gen(function* () {
    const controlState = yield* Ref.get(controlRef);
    const ampere = yield* chargingSpeedController.determineChargingSpeed(
      controlState.running ? controlState.ampere : 0
    );

    yield* Effect.logDebug("Charging speed determined.", {
      current_speed: controlState.ampere,
      determined_speed: ampere
    });

    yield* AmpereSync.syncTargetAmpere(ampere, controlRef, statsRef, config, isDryRun, eventLogger, pubSub).pipe(
      Effect.tap(() =>
        Effect.annotateCurrentSpan({
          chargeState: controlState,
          expectedAmpere: ampere
        })
      ),
      Effect.withSpan("syncAmpere")
    );

    yield* Effect.sleep(config.syncIntervalInMs).pipe(Effect.withSpan("syncAmpere.postWaiting"));

    const currentControlState = yield* Ref.get(controlRef);
    yield* ChargeVerifier.verifyCharging(currentControlState, batteryStateManager, onBatteryComplete);

    yield* Effect.annotateCurrentSpan({ memory_usage_mb: memoryUsageMB() });
  });

  return syncBody.pipe(
    Effect.withSpan("syncChargingRateBasedOnExcess"),
    Effect.retry({
      times: 2,
      while: (err) => {
        if (err._tag !== "VehicleAsleepError") return false;
        return Effect.sleep(Duration.millis(config.vehicleAwakeningTimeInMs)).pipe(
          Effect.flatMap(() => TeslaClient.wakeUpCar().pipe(Effect.map(() => true))),
          Effect.catchAll((err) => Effect.log(err).pipe(Effect.map(() => false)))
        );
      }
    }),
    Effect.catchTag("VehicleAsleepError", () =>
      Effect.fail(new VehicleNotWakingUpError({ wakeupAttempts: 2 }))
    ),
    Effect.retry({
      times: 10,
      while: (err) => {
        if (err._tag !== "AbruptProductionDrop") return false;
        return Effect.log("AbruptProductionDropError", {
          initialProduction: err.initialProduction,
          currentProduction: err.currentProduction
        }).pipe(Effect.map(() => true));
      }
    }),
    Effect.catchTag("AbruptProductionDrop", () =>
      Effect.dieMessage("Unexpectedly got AbruptProductionDrop 10 times consecutively.")
    )
  );
};
```

**2f. Create `src/application/session-lifecycle.ts`** (~80 lines)

Extracts session start/stop and summary computation. `beginSession` takes only `statsRef` (it sets session stats, not control state). `endSession` takes both Refs (reads `running` from control, reads all stats for the summary):

```typescript
import { TeslaClient, type AuthenticationFailedError } from "../tesla-client/index.js";
import {
  DataAdapter, DataNotAvailableError, SourceNotAvailableError
} from "../data-adapter/types.js";
import { BatteryStateManager } from "../battery-state-manager.js";
import type { IEventLogger } from "../event-logger/types.js";
import type { TeslaChargerEvent } from "../events.js";
import type {
  ChargingControlState, ChargingSessionStats, TimingConfig
} from "../domain/charging-session.js";
import {
  withDailyImportRecorded, withSessionStarted, withChargeEnergyRecorded
} from "../domain/charging-session.js";
import { computeSessionSummary } from "../domain/session-summary.js";
import * as ChargeCommands from "./charge-commands.js";
import { Duration, Effect, Fiber, PubSub, Ref } from "effect";

// ── Begin session ──

export const beginSession = (
  teslaClient: TeslaClient,
  dataAdapter: DataAdapter,
  batteryStateManager: BatteryStateManager,
  statsRef: Ref.Ref<ChargingSessionStats>,
  pubSub: PubSub.PubSub<TeslaChargerEvent>
): Effect.Effect<
  { batteryManagerFiber: Fiber.RuntimeFiber<void, never>; tokenRefreshFiber: Fiber.RuntimeFiber<void, AuthenticationFailedError> },
  AuthenticationFailedError | DataNotAvailableError | SourceNotAvailableError,
  TeslaClient | DataAdapter | BatteryStateManager
> =>
  Effect.gen(function* () {
    yield* teslaClient.refreshAccessToken();
    const tokenRefreshFiber = yield* teslaClient.setupAccessTokenAutoRefreshRecurring(7200).pipe(
      Effect.flatMap(() => Effect.void),
      Effect.fork
    );
    yield* Effect.sleep(1000);

    const { daily_import } = yield* dataAdapter.queryLatestValues(["daily_import"]);
    yield* Ref.update(statsRef, (s) => withDailyImportRecorded(withSessionStarted(s), daily_import));

    const initialChargeState = yield* teslaClient.getChargeState().pipe(
      Effect.catchAll(() => Effect.succeed(null))
    );
    if (initialChargeState) {
      yield* Ref.update(statsRef, (s) => withChargeEnergyRecorded(s, initialChargeState.chargeEnergyAdded));
    }

    const batteryManagerFiber = yield* batteryStateManager.start(pubSub).pipe(Effect.fork);
    return { batteryManagerFiber, tokenRefreshFiber };
  });

// ── End session ──

export const endSession = (
  teslaClient: TeslaClient,
  dataAdapter: DataAdapter,
  eventLogger: IEventLogger,
  controlRef: Ref.Ref<ChargingControlState>,
  statsRef: Ref.Ref<ChargingSessionStats>,
  pubSub: PubSub.PubSub<TeslaChargerEvent>,
  batteryStateManagerFiber: Fiber.RuntimeFiber<void, never> | undefined,
  tokenRefreshFiber: Fiber.RuntimeFiber<void, AuthenticationFailedError> | undefined,
  mainSyncFiber: Fiber.RuntimeFiber<void, never> | undefined,
  runtimeMonitorFiber: Fiber.RuntimeFiber<void, never> | undefined,
  config: { isDryRun: boolean; costPerKwh?: number; timingConfig: TimingConfig }
): Effect.Effect<void, never, TeslaClient | DataAdapter> =>
  Effect.gen(function* () {
    const controlState = yield* Ref.get(controlRef);
    const stats = yield* Ref.get(statsRef);

    yield* Effect.log("Stopping app and interrupting all fibers", {
      ampereFluctuations: stats.ampereFluctuations
    });

    yield* PubSub.shutdown(pubSub);

    if (controlState.running) {
      yield* Effect.retry(ChargeCommands.stopCharging(config.isDryRun), {
        times: 3,
        while: (err) => {
          if (err._tag === "VehicleAsleepError") {
            return Effect.sleep(Duration.millis(config.timingConfig.vehicleAwakeningTimeInMs)).pipe(
              Effect.flatMap(() => teslaClient.wakeUpCar().pipe(Effect.map(() => true))),
              Effect.catchAll((err) => Effect.log(err).pipe(Effect.map(() => false)))
            );
          }
          return true;
        }
      });
    }

    // Interrupt all fibers
    const fibers = [batteryStateManagerFiber, tokenRefreshFiber, mainSyncFiber, runtimeMonitorFiber].filter(
      (f): f is Fiber.RuntimeFiber<unknown> => f !== undefined
    );
    for (const fiber of fibers) {
      yield* Fiber.interrupt(fiber);
    }

    // Compute and emit session summary
    const finalChargeState = yield* teslaClient.getChargeState().pipe(
      Effect.catchAll(() =>
        Effect.succeed({ chargeEnergyAdded: stats.chargeEnergyAddedAtStartKwh })
      )
    );
    const finalDataValues = yield* dataAdapter.queryLatestValues(["daily_import", "voltage"]).pipe(
      Effect.catchAll(() =>
        Effect.succeed({ daily_import: stats.dailyImportValueAtStart, voltage: 230 })
      )
    );

    const summary = computeSessionSummary({
      stats,
      finalChargeEnergyAdded: finalChargeState.chargeEnergyAdded,
      finalDailyImport: finalDataValues.daily_import,
      finalVoltage: finalDataValues.voltage,
      costPerKwh: config.costPerKwh ?? 0.3
    });
    yield* eventLogger.onSessionEnd(summary);
  });

// ── Max runtime ──

export const shutdownAfterMaxRuntime = (
  maxHours: number,
  stop: Effect.Effect<void>
): Effect.Effect<void> =>
  Effect.sleep(Duration.hours(maxHours)).pipe(Effect.flatMap(() => stop));
```

### Task 3: Rewrite app.ts to use domain + application modules

Rewrite `src/app.ts` from scratch (~120 lines, down from 461). The file becomes a thin orchestrator that:

1. Creates `Ref<ChargingControlState>` for charge-control state
2. Creates `Ref<ChargingSessionStats>` for session-tracking stats
3. Creates `Ref<AppStatus>` for lifecycle tracking
4. Wires domain + application functions together
5. Manages fiber lifecycle

```typescript
import { TeslaClient } from "./tesla-client/index.js";
import { DataNotAvailableError, SourceNotAvailableError, DataAdapter } from "./data-adapter/types.js";
import {
  ChargingSpeedController,
  type InadequateDataToDetermineSpeedError
} from "./charging-speed-controller/types.js";
import type { IEventLogger } from "./event-logger/types.js";
import { EventLogger } from "./event-logger/index.js";
import { NotChargingAccordingToExpectedSpeedError } from "./errors/not-charging-according-to-expected-speed.error.js";
import { Context, Effect, Fiber, Layer, PubSub, Ref } from "effect";
import { type AuthenticationFailedError, type VehicleCommandFailedError } from "./tesla-client/errors.js";
import { VehicleNotWakingUpError } from "./errors/vehicle-not-waking-up.error.js";
import { BatteryStateManager } from "./battery-state-manager.js";
import type { TeslaChargerEvent } from "./events.js";
import { AbruptProductionDropError } from "./errors/abrupt-production-drop.error.js";

// Re-export types for backward compatibility
export type { TimingConfig } from "./domain/charging-session.js";
import type { TimingConfig } from "./domain/charging-session.js";
import { AppStatus, createInitialChargingControlState, createInitialChargingSessionStats } from "./domain/charging-session.js";
import * as SessionLifecycle from "./application/session-lifecycle.js";
import * as ChargeSyncLoop from "./application/charge-sync-loop.js";

export type App = {
  readonly start: () => Effect.Effect<
    void,
    | AuthenticationFailedError
    | DataNotAvailableError
    | SourceNotAvailableError
    | NotChargingAccordingToExpectedSpeedError
    | InadequateDataToDetermineSpeedError
    | VehicleNotWakingUpError
    | VehicleCommandFailedError
  >;
  readonly stop: () => Effect.Effect<void, never>;
};

export const App = Context.GenericTag<App>("@tesla-charger/App");

export const AppLayer = (config: {
  readonly timingConfig: TimingConfig;
  readonly isDryRun?: boolean;
  readonly eventLogger?: IEventLogger;
  readonly costPerKwh?: number;
}) =>
  Layer.effect(
    App,
    Effect.gen(function* () {
      const teslaClient = yield* TeslaClient;
      const dataAdapter = yield* DataAdapter;
      const chargingSpeedController = yield* ChargingSpeedController;
      const batteryStateManager = yield* BatteryStateManager;
      const eventLogger = config.eventLogger ?? new EventLogger();
      const isDryRun = config.isDryRun ?? false;
      const pubSub = yield* PubSub.unbounded<TeslaChargerEvent>();

      // Two Refs replace the old monolithic ChargingState
      const controlRef = yield* Ref.make(createInitialChargingControlState());
      const statsRef = yield* Ref.make(createInitialChargingSessionStats());
      const appStatusRef = yield* Ref.make(AppStatus.Pending);

      // Fiber references — set during start(), read during stop()
      let tokenRefreshFiber: Fiber.RuntimeFiber<void, AuthenticationFailedError>;
      let batteryStateManagerFiber: Fiber.RuntimeFiber<void, never>;
      let mainSyncFiber: Fiber.RuntimeFiber<void, never>;
      let runtimeMonitorFiber: Fiber.RuntimeFiber<void, never> | undefined;

      const stop = Effect.gen(function* () {
        yield* SessionLifecycle.endSession(
          teslaClient,
          dataAdapter,
          eventLogger,
          controlRef,
          statsRef,
          pubSub,
          batteryStateManagerFiber,
          tokenRefreshFiber,
          mainSyncFiber,
          runtimeMonitorFiber,
          { isDryRun, costPerKwh: config.costPerKwh, timingConfig: config.timingConfig }
        );
        yield* Ref.set(appStatusRef, AppStatus.Stopped);
      }).pipe(Effect.orDie);

      const start = Effect.fn("start")(function* () {
        yield* Ref.set(appStatusRef, AppStatus.Running);

        const sessionFibers = yield* SessionLifecycle.beginSession(
          teslaClient,
          dataAdapter,
          batteryStateManager,
          statsRef,
          pubSub
        );
        tokenRefreshFiber = sessionFibers.tokenRefreshFiber;
        batteryStateManagerFiber = sessionFibers.batteryManagerFiber;

        const onBatteryComplete = stop;

        mainSyncFiber = yield* Effect.repeat(
          ChargeSyncLoop.runChargingSyncLoop(
            chargingSpeedController,
            controlRef,
            statsRef,
            config.timingConfig,
            isDryRun,
            eventLogger,
            pubSub,
            batteryStateManager,
            onBatteryComplete
          ).pipe(Effect.map(() => Ref.get(appStatusRef))),
          { while: (status) => status === AppStatus.Running }
        ).pipe(Effect.flatMap(() => Effect.void), Effect.fork);

        if (config.timingConfig.maxRuntimeHours) {
          runtimeMonitorFiber = yield* SessionLifecycle.shutdownAfterMaxRuntime(
            config.timingConfig.maxRuntimeHours,
            stop
          ).pipe(Effect.fork);
        }

        yield* Fiber.joinAll(
          [
            tokenRefreshFiber,
            batteryStateManagerFiber,
            mainSyncFiber,
            runtimeMonitorFiber
          ].filter((f): f is Fiber.RuntimeFiber<unknown> => f !== undefined) as any
        );
      });

      return { start, stop };
    })
  );
```

The rewritten app.ts:
- ~120 lines (down from 461)
- Uses `Ref<ChargingControlState>` and `Ref<ChargingSessionStats>` (two focused Refs instead of one monolithic state)
- Uses `Ref<AppStatus>` for lifecycle
- `lastCommandAt` removed entirely
- All business logic delegated to application modules
- Public `App` tag interface unchanged
- `AppLayer` factory signature unchanged

## State Usage Matrix

| Function | Needs ControlState | Needs SessionStats | Takes |
|---|---|---|---|
| `syncTargetAmpere` | read + write | write (fluctuations) | `Ref<ChargingControlState>`, `Ref<ChargingSessionStats>` |
| `runChargingSyncLoop` | read → pass to sub-fns | pass-through | `Ref<ChargingControlState>`, `Ref<ChargingSessionStats>` |
| `verifyCharging` | read only (`running`, `ampere`) | none | `ChargingControlState` value |
| `beginSession` | none | write (stats init) | `Ref<ChargingSessionStats>` |
| `endSession` | read only (`running`) | read all stats | `Ref<ChargingControlState>`, `Ref<ChargingSessionStats>` |

## Testing Plan

### Existing Tests (must pass without changes)

All 9 tests in `src/tests/unit/app.test.ts` continue to function as-is:
- Test through `App` tag interface (unchanged)
- Mock TeslaClient, DataAdapter, ChargingSpeedController, BatteryStateManager, EventLogger via Layer (unchanged)
- Timing-based tests using TestClock (unchanged timing logic)

Expected import path changes (if any):
- `import { App, AppLayer, type TimingConfig } from "../../app.js"` — same path (re-exported)
- `import type { IEventLogger, SessionSummary } from "../../event-logger/types.js"` — same path (re-exported)

### New Unit Tests (not required for this refactoring, but recommended as follow-up)

Domain functions can be unit-tested independently:
- `withChargeStarted`, `withChargeStopped`, `withAmpereSet` on `ChargingControlState`
- `recordFluctuation`, `withDailyImportRecorded`, `withChargeEnergyRecorded`, `withSessionStarted` on `ChargingSessionStats`
- `computeSessionSummary` with various inputs
- `calculateRampUpWaitSeconds` with various amp differences

## Verification Checklist

Before signaling `TASK_COMPLETE`, verify:

- [ ] `app.ts` is ~120 lines (significantly reduced from 461)
- [ ] `ChargingControlState` and `ChargingSessionStats` are separate types
- [ ] `lastCommandAt` is removed from all code
- [ ] All 3 new domain files exist under `src/domain/` (`charging-session.ts`, `session-summary.ts`, `timing.ts`)
- [ ] All 6 new application files exist under `src/application/`
- [ ] `src/event-logger/types.ts` re-exports `SessionSummary` from domain
- [ ] `App` tag interface unchanged (`start`/`stop` with same error types)
- [ ] `AppLayer` factory signature unchanged
- [ ] `main.ts` compiles without changes
- [ ] `npx tsc --noEmit` passes (typecheck)
- [ ] `npm run lint` passes
- [ ] `npm test` passes (all 9 app tests + all other tests)

**Note**: CI checks (build, lint, test) are run automatically.

## Rollback Plan

1. Revert `src/app.ts` to previous version
2. Remove `src/domain/` directory
3. Remove `src/application/` directory
4. Revert `src/event-logger/types.ts` to inline `SessionSummary` type

All changes are additive (no modifications to existing tests or other source files), so rollback is straightforward.

## Future Considerations

- Unit test domain pure functions independently
- Migrate `BatteryStateManager` to use `Ref` internally (same pattern)
- Migrate `Context.GenericTag` → class-based `Context.Tag` across services
- Replace `Effect.dieMessage` calls with typed errors
- Remove dead code (`src/constants.ts`, unused `ITeslaClient` type, InfluxDB `authenticate()`)

## Spec Readiness Checklist

Before running ralph-loop.sh, verify:

- [x] All requirements are clearly defined (no unanswered questions)
- [x] All tasks are actionable and appropriately sized (1-4 hours each)
- [x] **All tasks are atomic (each task leaves codebase in working state)**
- [x] Implementation details are specific enough to execute
- [x] Testing plan covers happy path and error cases
- [x] Verification steps are concrete and testable
- [x] Rollback plan exists
