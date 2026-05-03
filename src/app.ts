import { TeslaClient, type TeslaClientService } from "./tesla-client/index.js";
import { DataNotAvailableError, SourceNotAvailableError, DataAdapter } from "./data-adapter/types.js";
import {
  ChargingSpeedController,
  type InadequateDataToDetermineSpeedError
} from "./charging-speed-controller/types.js";
import { AbruptProductionDropError } from "./errors/abrupt-production-drop.error.js";
import type { SessionSummary } from "./event-logger/types.js";
import { NotChargingAccordingToExpectedSpeedError } from "./errors/not-charging-according-to-expected-speed.error.js";
import { Context, Duration, Effect, Fiber, Layer, PubSub, Schedule } from "effect";
import { type AuthenticationFailedError, type VehicleCommandFailedError } from "./tesla-client/errors.js";
import { VehicleNotWakingUpError } from "./errors/vehicle-not-waking-up.error.js";
import { BatteryStateManager } from "./battery-state-manager.js";
import { memoryUsageMB } from "./memory-usage.js";
import { ElectricVehicle } from "./domain/electric-vehicle.js";
import { TeslaChargerEventPubSub, type TeslaChargerEvent } from "./domain/events.js";
import type { ChargingConfig } from "./domain/charging-session.js";
import {
  createInitialChargingControlState,
  createInitialChargingSessionStats,
  AppStatus
} from "./domain/charging-session.js";
import type { ChargingControlState, ChargingSessionStats } from "./domain/charging-session.js";
import { syncTargetAmpere } from "./domain/charge-sync.js";
import { startEventLogger } from "./event-logger/index.js";

export type TimingConfig = {
  syncIntervalInMs: number;
  vehicleAwakeningTimeInMs: number;
  inactivityTimeInSeconds: number;
  maxRuntimeHours?: number;
};

export class App extends Context.Tag("@tesla-charger/App")<
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
      | VehicleCommandFailedError,
      ElectricVehicle
    >;
    readonly stop: () => Effect.Effect<void, never>;
  }
>() {}

export const AppLayer = (config: {
  readonly chargingConfig: ChargingConfig;
  readonly timingConfig: TimingConfig;
  readonly isDryRun?: boolean;
  readonly costPerKwh?: number;
}) =>
  Layer.effect(
    App,
    Effect.gen(function* () {
      const teslaClient: TeslaClientService = yield* TeslaClient;
      const dataAdapter = yield* DataAdapter;
      const chargingSpeedController = yield* ChargingSpeedController;
      const batteryStateManager = yield* BatteryStateManager;
      const isDryRun = config.isDryRun ?? false;
      const teslaChargerPubSub = yield* PubSub.unbounded<TeslaChargerEvent>();

      let controlState: ChargingControlState = createInitialChargingControlState();
      let sessionStats: ChargingSessionStats = createInitialChargingSessionStats();

      let appStatus: AppStatus = AppStatus.Pending;
      let tokenRefreshFiber: Fiber.RuntimeFiber<void, AuthenticationFailedError> | undefined;
      let batteryStateManagerFiber: Fiber.RuntimeFiber<void, never> | undefined;
      let eventLoggerFiber: Fiber.RuntimeFiber<void, never> | undefined;
      let mainSyncFiber:
        | Fiber.RuntimeFiber<
            void,
            | AuthenticationFailedError
            | DataNotAvailableError
            | SourceNotAvailableError
            | NotChargingAccordingToExpectedSpeedError
            | InadequateDataToDetermineSpeedError
            | VehicleNotWakingUpError
            | VehicleCommandFailedError
          >
        | undefined;
      let runtimeMonitorFiber: Fiber.RuntimeFiber<void, never> | undefined;

      const waitAndWatchoutForSuddenDropInProduction = (currentProductionAtStart: number, timeInSeconds: number) =>
        Effect.race(
          Effect.void.pipe(Effect.delay(Duration.seconds(timeInSeconds))),
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
        );

      const syncAmpere = (targetAmpere: number) =>
        Effect.gen(function* () {
          const vehicle = yield* ElectricVehicle;
          const pubSub = yield* TeslaChargerEventPubSub;
          const { current_production: currentProductionAtStart } = yield* dataAdapter.queryLatestValues([
            "current_production"
          ]);

          const result = yield* syncTargetAmpere(
            targetAmpere,
            controlState,
            sessionStats,
            config.chargingConfig,
            isDryRun,
            vehicle,
            pubSub,
            (waitSeconds) => waitAndWatchoutForSuddenDropInProduction(currentProductionAtStart, waitSeconds)
          );
          controlState = result.state;
          sessionStats = result.stats;
        }).pipe(Effect.provideService(TeslaChargerEventPubSub, teslaChargerPubSub));

      const checkIfCorrectlyCharging = () =>
        Effect.gen(function* () {
          const { current_load: currentLoad, voltage } = yield* dataAdapter.queryLatestValues([
            "current_load",
            "voltage"
          ]);
          const currentLoadAmpere = currentLoad / voltage;

          if (controlState.status !== "Charging") return;
          const expectedAmpere = controlState.ampere;
          if (expectedAmpere <= 0) return;

          if (currentLoadAmpere < expectedAmpere) {
            yield* Effect.logDebug("load power not expected", {
              currentLoad,
              voltage,
              expectedAmpere
            });
          }

          const batteryState = batteryStateManager.get();
          if (batteryState && batteryState.batteryLevel >= batteryState.chargeLimitSoc) {
            yield* Effect.log("Charge complete - battery level reached charge limit", {
              batteryLevel: batteryState.batteryLevel,
              chargeLimitSoc: batteryState.chargeLimitSoc
            });
            yield* stop();
          }
        });

      const syncChargingRateBasedOnExcess = () => {
        const base = Effect.gen(function* () {
          const currentSpeed = controlState.status === "Charging" ? controlState.ampere : 0;
          const ampere = yield* chargingSpeedController.determineChargingSpeed(currentSpeed);

          yield* Effect.logDebug("Charging speed determined.", {
            current_speed: currentSpeed,
            determined_speed: ampere
          });

          yield* syncAmpere(Math.min(32, ampere)).pipe(
            Effect.tap(() =>
              Effect.annotateCurrentSpan({
                chargeState: controlState,
                expectedAmpere: ampere
              })
            ),
            Effect.withSpan("syncAmpere")
          );

          yield* Effect.sleep(config.timingConfig.syncIntervalInMs).pipe(Effect.withSpan("syncAmpere.postWaiting"));

          yield* checkIfCorrectlyCharging();
        });

        const retried = base.pipe(
          Effect.tap(() =>
            Effect.annotateCurrentSpan({
              memory_usage_mb: memoryUsageMB()
            })
          ),
          Effect.withSpan("syncChargingRateBasedOnExcess"),
          Effect.retry({
            times: 2,
            while: (err) => {
              if (err._tag !== "VehicleAsleepError") return false;
              return Effect.sleep(Duration.millis(config.timingConfig.vehicleAwakeningTimeInMs)).pipe(
                Effect.flatMap(() => teslaClient.wakeUpCar().pipe(Effect.map(() => true))),
                Effect.catchAll(() => Effect.succeed(false))
              );
            }
          }),
          Effect.catchTag("VehicleAsleepError", () => Effect.fail(new VehicleNotWakingUpError({ wakeupAttempts: 2 }))),
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
            Effect.dieMessage("Unexpectedly got AbruptProductionDrop 10 times consecutively.")
          )
        );

        return retried;
      };

      const computeAndEmitSessionSummary = () =>
        Effect.gen(function* () {
          const sessionDurationMs = sessionStats.sessionStartedAt
            ? Date.now() - sessionStats.sessionStartedAt.getTime()
            : 0;

          const finalChargeState = yield* teslaClient
            .getChargeState()
            .pipe(
              Effect.catchAll(() => Effect.succeed({ chargeEnergyAdded: sessionStats.chargeEnergyAddedAtStartKwh }))
            );

          const finalDataValues = yield* dataAdapter
            .queryLatestValues(["daily_import", "voltage"])
            .pipe(
              Effect.catchAll(() =>
                Effect.succeed({ daily_import: sessionStats.dailyImportValueAtStart, voltage: 230 })
              )
            );

          const totalEnergyChargedKwh = finalChargeState.chargeEnergyAdded - sessionStats.chargeEnergyAddedAtStartKwh;
          const gridImportKwh = finalDataValues.daily_import - sessionStats.dailyImportValueAtStart;
          const solarEnergyUsedKwh = Math.max(0, totalEnergyChargedKwh - gridImportKwh);

          const sessionDurationHours = sessionDurationMs / 3_600_000;
          const averageChargingSpeedAmps =
            sessionDurationHours > 0 && finalDataValues.voltage > 0
              ? (totalEnergyChargedKwh * 1000) / (finalDataValues.voltage * sessionDurationHours)
              : 0;

          const costPerKwh = config.costPerKwh ?? 0.3;
          const gridImportCost = gridImportKwh * costPerKwh;

          const summary: SessionSummary = {
            sessionDurationMs,
            totalEnergyChargedKwh,
            gridImportKwh,
            solarEnergyUsedKwh,
            averageChargingSpeedAmps,
            ampereFluctuations: sessionStats.ampereFluctuations,
            gridImportCost
          };

          yield* PubSub.publish(teslaChargerPubSub, { _tag: "SessionEnded", summary });
        });

      const stop = () =>
        Effect.gen(function* () {
          yield* Effect.log("Stopping app and interrupting all fibers", {
            ampereFluctuations: sessionStats.ampereFluctuations
          });

          if (controlState.status !== "Idle") {
            yield* Effect.retry(isDryRun ? Effect.log("Stopping charging") : teslaClient.stopCharging(), {
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

          yield* computeAndEmitSessionSummary();
          yield* Effect.yieldNow();

          yield* PubSub.shutdown(teslaChargerPubSub);

          appStatus = AppStatus.Stopped;

          const interruptFibers = [
            batteryStateManagerFiber,
            eventLoggerFiber,
            tokenRefreshFiber,
            mainSyncFiber,
            runtimeMonitorFiber
          ].filter((f): f is NonNullable<typeof f> => f !== undefined);
          for (const fiber of interruptFibers) {
            yield* Fiber.interrupt(fiber);
          }
        }).pipe(Effect.orDie);

      const shutdownAfterMaxRuntimeHours = () =>
        Effect.gen(function* () {
          const maxHours = config.timingConfig.maxRuntimeHours;
          if (maxHours === undefined) {
            return yield* Effect.dieMessage("maxRuntimeHours is not set");
          }
          yield* Effect.sleep(Duration.hours(maxHours));
          yield* stop();
        });

      const start: App["Type"]["start"] = Effect.fn("start")(function* () {
        appStatus = AppStatus.Running;
        yield* teslaClient.refreshAccessToken();

        tokenRefreshFiber = yield* teslaClient.setupAccessTokenAutoRefreshRecurring(60 * 60 * 2).pipe(
          Effect.flatMap(() => Effect.void),
          Effect.fork
        );

        yield* Effect.sleep(1000);

        const initialData = yield* dataAdapter.queryLatestValues(["daily_import"]);
        sessionStats = {
          ...sessionStats,
          dailyImportValueAtStart: initialData.daily_import,
          sessionStartedAt: new Date()
        };

        const initialChargeState = yield* teslaClient
          .getChargeState()
          .pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (initialChargeState) {
          sessionStats = {
            ...sessionStats,
            chargeEnergyAddedAtStartKwh: initialChargeState.chargeEnergyAdded
          };
        }

        batteryStateManagerFiber = yield* batteryStateManager.start(teslaChargerPubSub).pipe(Effect.fork);
        eventLoggerFiber = yield* startEventLogger(teslaChargerPubSub).pipe(Effect.fork);

        mainSyncFiber = yield* Effect.repeat(syncChargingRateBasedOnExcess().pipe(Effect.map(() => appStatus)), {
          while: (status) => status === AppStatus.Running
        }).pipe(
          Effect.flatMap(() => Effect.void),
          Effect.fork
        );

        if (config.timingConfig.maxRuntimeHours) {
          runtimeMonitorFiber = yield* shutdownAfterMaxRuntimeHours().pipe(Effect.fork);
        }

        yield* Fiber.joinAll([
          tokenRefreshFiber,
          ...(batteryStateManagerFiber ? [batteryStateManagerFiber] : []),
          ...(eventLoggerFiber ? [eventLoggerFiber] : []),
          ...(mainSyncFiber ? [mainSyncFiber] : []),
          ...(runtimeMonitorFiber ? [runtimeMonitorFiber] : [])
        ] as const);
      });

      return { start, stop };
    })
  );
