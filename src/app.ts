import { TeslaClient } from "./tesla-client/index.js";
import { DataNotAvailableError, SourceNotAvailableError, DataAdapter } from "./data-adapter/types.js";
import {
  ChargingSpeedController,
  type InadequateDataToDetermineSpeedError
} from "./charging-speed-controller/types.js";
import { AbruptProductionDropError } from "./errors/abrupt-production-drop.error.js";
import { NotChargingAccordingToExpectedSpeedError } from "./errors/not-charging-according-to-expected-speed.error.js";
import { Context, Duration, Effect, Fiber, Layer, PubSub, Ref, Schedule } from "effect";
import type { AuthenticationFailedError, VehicleCommandFailedError } from "./tesla-client/errors.js";
import { VehicleNotWakingUpError } from "./errors/vehicle-not-waking-up.error.js";
import { BatteryStateManager } from "./battery-state-manager.js";
import { AppRuntime } from "./app-runtime.js";
import { memoryUsageMB } from "./memory-usage.js";
import { TeslaChargerEventPubSub, type TeslaChargerEvent } from "./domain/events.js";
import type { ChargingConfig } from "./domain/charging-session.js";
import { AppStatus } from "./domain/charging-session.js";
import { syncTargetAmpere } from "./application/charge-sync.js";
import { verifyCharging } from "./application/charge-verifier.js";
import { beginSession, endSession, shutdownAfterMaxRuntime } from "./application/session-lifecycle.js";
import { Ampere } from "./domain/brands.js";

export type TimingConfig = {
  syncIntervalInMs: number;
  vehicleAwakeningTimeInMs: number;
  inactivityTimeInSeconds: number;
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
      | NotChargingAccordingToExpectedSpeedError
      | InadequateDataToDetermineSpeedError
      | VehicleNotWakingUpError
      | VehicleCommandFailedError
    >;
    readonly stop: () => Effect.Effect<void, never>;
  }
>()("@tesla-charger/App") {}

type MainLoopErrors =
  | DataNotAvailableError
  | SourceNotAvailableError
  | InadequateDataToDetermineSpeedError
  | VehicleNotWakingUpError
  | VehicleCommandFailedError;

type FiberErrors = AuthenticationFailedError | MainLoopErrors;

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
      const chargingSpeedController = yield* ChargingSpeedController;
      const batteryStateManager = yield* BatteryStateManager;
      const appRuntime = yield* AppRuntime;
      const costPerKwh = config.costPerKwh ?? 0.3;
      const teslaChargerPubSub = yield* PubSub.unbounded<TeslaChargerEvent>();

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
            pubSub: teslaChargerPubSub,
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

      const start: App["Service"]["start"] = () =>
        Effect.gen(function* () {
          yield* Ref.set(appRuntime.appStatusRef, AppStatus.Running);

          const sessionFibers = yield* beginSession(
            teslaClient,
            dataAdapter,
            batteryStateManager,
            appRuntime.statsRef,
            teslaChargerPubSub
          );
          tokenRefreshFiber = sessionFibers.tokenRefreshFiber;
          batteryStateManagerFiber = sessionFibers.batteryStateManagerFiber;
          eventLoggerFiber = sessionFibers.eventLoggerFiber;

          const runSyncCycle = (): Effect.Effect<
            AppStatus,
            | DataNotAvailableError
            | SourceNotAvailableError
            | InadequateDataToDetermineSpeedError
            | VehicleNotWakingUpError
            | VehicleCommandFailedError
          > =>
            Effect.gen(function* () {
              const controlState = yield* Ref.get(appRuntime.controlRef);
              const currentSpeed = controlState.status === "Charging" ? controlState.ampere : Ampere(0);
              const ampere = yield* chargingSpeedController.determineChargingSpeed(currentSpeed);

              yield* Effect.logDebug("Charging speed determined.", {
                current_speed: currentSpeed,
                determined_speed: ampere
              });

              const targetAmpere = ampere;
              const sessionStats = yield* Ref.get(appRuntime.statsRef);
              const { current_production: currentProductionAtStart } = yield* dataAdapter.queryLatestValues([
                "current_production"
              ]);

              const result = yield* syncTargetAmpere(
                targetAmpere,
                controlState,
                sessionStats,
                config.chargingConfig,
                (waitSeconds) =>
                  Effect.race(
                    Effect.void.pipe(Effect.delay(Duration.seconds(waitSeconds))),
                    Effect.repeat(
                      Effect.gen(function* () {
                        const { current_production: currentProduction, import_from_grid: importingFromGrid } =
                          yield* dataAdapter.queryLatestValues(["current_production", "import_from_grid"]);
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
                        return;
                      }),
                      Schedule.fixed(Duration.seconds(4))
                    )
                  ),
                teslaClient
              ).pipe(
                Effect.tap(() =>
                  Effect.annotateCurrentSpan({
                    chargeState: controlState,
                    expectedAmpere: ampere
                  })
                ),
                Effect.withSpan("syncAmpere"),
                Effect.provideService(TeslaChargerEventPubSub, teslaChargerPubSub)
              );

              yield* Ref.set(appRuntime.controlRef, result.state);
              yield* Ref.set(appRuntime.statsRef, result.stats);

              yield* Effect.sleep(config.timingConfig.syncIntervalInMs).pipe(Effect.withSpan("syncAmpere.postWaiting"));

              const currentControlState = yield* Ref.get(appRuntime.controlRef);
              yield* verifyCharging(dataAdapter, batteryStateManager, currentControlState, stop());

              return yield* Ref.get(appRuntime.appStatusRef);
            }).pipe(
              Effect.tap(() =>
                Effect.annotateCurrentSpan({
                  memory_usage_mb: memoryUsageMB()
                })
              ),
              Effect.retry({
                times: 2,
                while: (err) => {
                  if (err._tag !== "VehicleAsleepError") return false;
                  return Effect.sleep(Duration.millis(config.timingConfig.vehicleAwakeningTimeInMs)).pipe(
                    Effect.flatMap(() => teslaClient.wakeUpCar().pipe(Effect.map(() => true))),
                    Effect.catch(() => Effect.succeed(false))
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
                  return Effect.succeed(true).pipe(
                    Effect.tap(() =>
                      Effect.log("AbruptProductionDropError", {
                        initialProduction: err.initialProduction,
                        currentProduction: err.currentProduction
                      })
                    )
                  );
                }
              }),
              Effect.catchTag("AbruptProductionDrop", () =>
                Effect.die(new Error("Unexpectedly got AbruptProductionDrop 10 times consecutively."))
              )
            );

          mainSyncFiber = yield* Effect.repeat(runSyncCycle(), {
            while: (status) => status === AppStatus.Running
          }).pipe(
            Effect.flatMap(() => Effect.void),
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
