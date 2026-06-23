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
import { beginSession, endSession, shutdownAfterMaxRuntime } from "./application/session-lifecycle.js";

export type TimingConfig = {
  syncIntervalInMs: number;
  vehicleAwakeningTimeInMs: number;
  maxRuntimeHours?: number;
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
      let mainSyncFiber: Fiber.Fiber<void, FiberErrors> | undefined;
      let runtimeMonitorFiber: Fiber.Fiber<void, FiberErrors> | undefined;

      const stop = Effect.fn("stop")(
        function* () {
          yield* endSession({
            teslaClient,
            dataAdapter,
            controlRef: appRuntime.controlRef,
            statsRef: appRuntime.statsRef,
            pubSub,
            costPerKwh,
            timingConfig: config.timingConfig,
            fibers: [
              batteryStateManagerFiber,
              eventLoggerFiber,
              tokenRefreshFiber,
              mainSyncFiber,
              runtimeMonitorFiber
            ].filter((f): f is NonNullable<typeof f> => f !== undefined)
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
          pubSub
        );
        tokenRefreshFiber = sessionFibers.tokenRefreshFiber;
        batteryStateManagerFiber = sessionFibers.batteryStateManagerFiber;
        eventLoggerFiber = sessionFibers.eventLoggerFiber;

        const runSyncCycle = Effect.fn("runSyncCycle")(function* () {
          const controlState = yield* Ref.get(appRuntime.controlRef);
          const sessionStats = yield* Ref.get(appRuntime.statsRef);

          const result = yield* chargingSession.runCycle(controlState, sessionStats);

          yield* Ref.set(appRuntime.controlRef, result.state);
          yield* Ref.set(appRuntime.statsRef, result.stats);

          return result.outcome;
        });

        mainSyncFiber = yield* Effect.repeat(runSyncCycle(), {
          while: (outcome) => outcome.status === "Running"
        }).pipe(
          Effect.flatMap(() => stop()),
          Effect.catchTag("GridImportExhausted", (err) => Effect.die(err)),
          Effect.catchTag("VehicleNotWakingUp", (err) => Effect.die(err)),
          Effect.forkChild
        );

        if (config.timingConfig.maxRuntimeHours) {
          runtimeMonitorFiber = yield* shutdownAfterMaxRuntime(config.timingConfig.maxRuntimeHours, stop()).pipe(
            Effect.forkChild
          );
        }

        const fibers: Fiber.Fiber<void, FiberErrors>[] = [
          tokenRefreshFiber,
          batteryStateManagerFiber,
          eventLoggerFiber,
          mainSyncFiber
        ];
        if (runtimeMonitorFiber) fibers.push(runtimeMonitorFiber);
        yield* Fiber.joinAll(fibers);
      });

      return { start, stop };
    }).pipe(Effect.withSpan("AppLayer"))
  );
