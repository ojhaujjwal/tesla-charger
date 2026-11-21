import { TeslaClient } from "./tesla-client/index.js";
import { DataNotAvailableError, SourceNotAvailableError, DataAdapter } from "./data-adapter/types.js";
import { type InadequateDataToDetermineSpeedError } from "./charging-speed-controller/types.js";
import { GridImportExhaustedError } from "./errors/grid-import-exhausted.error.js";
import { Context, Effect, Fiber, Layer, Ref } from "effect";
import type { AuthenticationFailedError, VehicleCommandFailedError } from "./tesla-client/errors.js";
import { VehicleNotWakingUpError } from "./errors/vehicle-not-waking-up.error.js";
import { BatteryStateManager } from "./battery-state-manager.js";
import { AppRuntime, AppStatus } from "./app-runtime.js";
import { TeslaChargerEventPubSub } from "./domain/events.js";
import type { ChargingConfig } from "./domain/charging-session.js";
import { ChargingSession } from "./domain/charging-session.js";
import type { TimeOfDay } from "./domain/brands.js";
import { beginSession, endSession, sleepUntilTimeOfDay } from "./application/session-lifecycle.js";

export type TimingConfig = {
  syncIntervalInMs: number;
  vehicleAwakeningTimeInMs: number;
  shutdownAt?: TimeOfDay;
};

export class App extends Context.Service<
  App,
  {
    readonly start: () => Effect.Effect<
      void,
      | AuthenticationFailedError
      | DataNotAvailableError
      | SourceNotAvailableError
      | InadequateDataToDetermineSpeedError
      | VehicleNotWakingUpError
      | VehicleCommandFailedError
      | GridImportExhaustedError
    >;
    readonly stop: () => Effect.Effect<void, never>;
  }
>()("@tesla-charger/App") {}

type FiberErrors =
  | AuthenticationFailedError
  | DataNotAvailableError
  | SourceNotAvailableError
  | InadequateDataToDetermineSpeedError
  | VehicleNotWakingUpError
  | VehicleCommandFailedError;

export const AppLayer = (config: {
  readonly chargingConfig: ChargingConfig;
  readonly timingConfig: TimingConfig;
  readonly costPerKwh?: number;
  readonly forceChargeToHundredPercent?: boolean;
}) =>
  Layer.effect(
    App,
    Effect.gen(function* () {
      const teslaClient = yield* TeslaClient;
      const dataAdapter = yield* DataAdapter;
      const chargingSession = yield* ChargingSession;
      const batteryStateManager = yield* BatteryStateManager;
      const appRuntime = yield* AppRuntime;
      const pubSub = yield* TeslaChargerEventPubSub;
      const costPerKwh = config.costPerKwh ?? 0.3;

      let tokenRefreshFiber: Fiber.Fiber<void, FiberErrors> | undefined;
      let batteryStateManagerFiber: Fiber.Fiber<void, FiberErrors> | undefined;
      let eventLoggerFiber: Fiber.Fiber<void, FiberErrors> | undefined;
      let mainSyncFiber: Fiber.Fiber<unknown, FiberErrors> | undefined;
      let shutdownAtTimeFiber: Fiber.Fiber<void, FiberErrors> | undefined;
      const hasStoppedRef = yield* Ref.make(false);

      const stop = Effect.fn("stop")(
        function* () {
          const alreadyStopped = yield* Ref.getAndSet(hasStoppedRef, true);
          if (alreadyStopped) return;

          yield* endSession({
            teslaClient,
            dataAdapter,
            controlRef: appRuntime.controlRef,
            statsRef: appRuntime.statsRef,
            pubSub,
            costPerKwh,
            timingConfig: config.timingConfig,
            fibers: [batteryStateManagerFiber, eventLoggerFiber, tokenRefreshFiber, mainSyncFiber].filter(
              (f): f is NonNullable<typeof f> => f !== undefined
            )
          });

          yield* Ref.set(appRuntime.appStatusRef, AppStatus.Stopped);
        },
        (eff) => eff.pipe(Effect.orDie)
      );

      const start: App["Service"]["start"] = Effect.fn("start")(function* () {
        yield* Ref.set(appRuntime.appStatusRef, AppStatus.Running);

        const sessionFibers = yield* beginSession(
          teslaClient,
          dataAdapter,
          batteryStateManager,
          appRuntime.statsRef,
          pubSub,
          { forceChargeToHundredPercent: config.forceChargeToHundredPercent ?? false }
        );
        tokenRefreshFiber = sessionFibers.tokenRefreshFiber;
        batteryStateManagerFiber = sessionFibers.batteryStateManagerFiber;
        eventLoggerFiber = sessionFibers.eventLoggerFiber;

        const runSyncCycle = Effect.fn("runSyncCycle", { root: true })(function* () {
          const controlState = yield* Ref.get(appRuntime.controlRef);
          const sessionStats = yield* Ref.get(appRuntime.statsRef);

          const result = yield* chargingSession.runCycle(controlState, sessionStats);

          yield* Ref.set(appRuntime.controlRef, result.state);
          yield* Ref.set(appRuntime.statsRef, result.stats);

          return result.outcome;
        });

        const mainSync = yield* Effect.repeat(runSyncCycle(), {
          while: (outcome) => outcome.status === "Running"
        }).pipe(
          Effect.catchTag("GridImportExhausted", (err) => Effect.die(err)),
          Effect.catchTag("VehicleNotWakingUp", (err) => Effect.die(err)),
          Effect.forkChild
        );
        mainSyncFiber = mainSync;

        // End the session when the sync loop finishes on its own (for example,
        // the vehicle reaches its charge limit) or when SHUTDOWN_AT is reached.
        const shutdownAt = config.timingConfig.shutdownAt;
        shutdownAtTimeFiber = yield* Effect.raceFirst(
          Fiber.join(mainSync),
          shutdownAt !== undefined ? sleepUntilTimeOfDay(shutdownAt) : Effect.never
        ).pipe(
          Effect.flatMap(() => stop()),
          Effect.forkChild
        );

        yield* Fiber.join(shutdownAtTimeFiber);
      });

      return { start, stop };
    }).pipe(Effect.withSpan("AppLayer"))
  );
