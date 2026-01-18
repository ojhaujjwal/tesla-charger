import { TeslaClient } from './tesla-client/index.js';
import { DataNotAvailableError, SourceNotAvailableError, DataAdapter } from './data-adapter/types.js';
import { ChargingSpeedController, type InadequateDataToDetermineSpeedError } from './charging-speed-controller/types.js';
import { AbruptProductionDropError } from './errors/abrupt-production-drop.error.js';
import type { IEventLogger } from './event-logger/types.js';
import { EventLogger } from './event-logger/index.js';
import { NotChargingAccordingToExpectedSpeedError } from './errors/not-charging-according-to-expected-speed.error.js';
import { Context, Duration, Effect, Fiber, Layer, pipe, Schedule } from 'effect';
import { type AuthenticationFailedError, type VehicleCommandFailedError } from './tesla-client/errors.js';
import { VehicleNotWakingUpError } from './errors/vehicle-not-waking-up.error.js';


type ChargingState = {
  running: boolean;
  ampere: number;
  ampereFluctuations: number;
  lastCommandAt: Date | null;
  dailyImportValueAtStart: number;
};

enum AppStatus {
  Pending,
  Running,
  Stopped,
}

export type TimingConfig = {
  syncIntervalInMs: number;
  vehicleAwakeningTimeInMs: number;
  inactivityTimeInSeconds: number;
  waitPerAmereInSeconds: number,
  extraWaitOnChargeStartInSeconds: number;
  extraWaitOnChargeStopInSeconds: number;
  maxRuntimeHours?: number;
};

export type App = {
  readonly start: () => Effect.Effect<
    void,
    AuthenticationFailedError
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
}) => Layer.effect(
  App,
  Effect.gen(function* () {
    const teslaClient = yield* TeslaClient;
    const dataAdapter = yield* DataAdapter;
    const chargingSpeedController = yield* ChargingSpeedController;
    const eventLogger = config.eventLogger ?? new EventLogger();
    const isDryRun = config.isDryRun ?? false;

    let chargeState: ChargingState = {
      running: false,
      ampere: 0,
      ampereFluctuations: 0,
      lastCommandAt: null,
      dailyImportValueAtStart: 0,
    };

    let appStatus: AppStatus = AppStatus.Pending;
    let tokenRefreshFiber: Fiber.RuntimeFiber<void, AuthenticationFailedError> | undefined;
    let mainSyncFiber: Fiber.RuntimeFiber<void, AuthenticationFailedError
      | DataNotAvailableError
      | SourceNotAvailableError
      | NotChargingAccordingToExpectedSpeedError
      | InadequateDataToDetermineSpeedError
      | VehicleNotWakingUpError
      | VehicleCommandFailedError> | undefined;
    let runtimeMonitorFiber: Fiber.RuntimeFiber<void, never> | undefined;

    const memoryUsageMB = () => process.memoryUsage().heapUsed / 1024 / 1024;

    const waitAndWatchoutForSuddenDropInProduction = (
      currentProductionAtStart: number,
      timeInSeconds: number,
    ) => Effect.race(
      Effect.void.pipe(Effect.delay(Duration.seconds(timeInSeconds))),
      Effect.repeat(Effect.gen(function* () {
        const {
          current_production: currentProduction,
          import_from_grid: importingFromGrid
        } = yield* dataAdapter.queryLatestValues(['current_production', 'import_from_grid']);

        yield* Effect.logDebug('watching for sudden drop in production', {
          currentProduction,
          currentProductionAtStart,
          importingFromGrid,
        });
        if (importingFromGrid > 0) {
          return yield* Effect.fail(new AbruptProductionDropError({ initialProduction: currentProductionAtStart, currentProduction }));
        }

        return Effect.void;
      }), Schedule.fixed(Duration.seconds(4)),
      )
    );

    const startCharging = () => (isDryRun ? Effect.log('Starting charging') : teslaClient.startCharging())
      .pipe(
        Effect.tap(() => {
          chargeState = {
            ...chargeState,
            running: true,
            lastCommandAt: new Date(),
          };
        })
      );

    const stopChargingAction = () => (isDryRun ? Effect.log('Stopping charging') : teslaClient.stopCharging())
      .pipe(
        Effect.tap(() => {
          chargeState = {
            ...chargeState,
            ampere: 0,
            running: false,
            lastCommandAt: new Date(),
          };
        })
      );

    const setAmpere = (ampere: number) => (isDryRun ? Effect.log(`Setting ampere to ${ampere}`) : teslaClient.setAmpere(ampere))
      .pipe(
        Effect.tap(() => {
          chargeState = {
            ...chargeState,
            ampere,
            lastCommandAt: new Date(),
          };
        })
      );

    const syncAmpere = (ampere: number) => Effect.gen(function* () {
      const { current_production: currentProductionAtStart } = yield* dataAdapter.queryLatestValues(['current_production']);

      const stopCharging = ampere < 3;

      if (stopCharging && chargeState.running) {
        yield* stopChargingAction();
        yield* Effect.sleep(Duration.seconds(config.timingConfig.extraWaitOnChargeStopInSeconds));
        return;
      }

      if (stopCharging) return;

      const shouldStartToCharge = !stopCharging && !chargeState.running;

      if (shouldStartToCharge) {
        yield* startCharging();
      }

      if (ampere !== chargeState.ampere) {
        const ampDifference = ampere - chargeState.ampere;
        yield* eventLogger.onSetAmpere(ampere);
        yield* setAmpere(ampere);

        const secondsToWait = Math.abs(ampDifference) * config.timingConfig.waitPerAmereInSeconds;

        if (ampDifference > 0) {
          yield* waitAndWatchoutForSuddenDropInProduction(
            currentProductionAtStart,
            secondsToWait + (shouldStartToCharge ? config.timingConfig.extraWaitOnChargeStartInSeconds : 0)
          );
        } else {
          yield* Effect.sleep(Duration.seconds(secondsToWait));
        }
      } else {
        yield* eventLogger.onNoAmpereChange(ampere);
      }
    });

    const checkIfCorrectlyCharging = () => Effect.gen(function* () {
      const { current_load: currentLoad, voltage } = yield* dataAdapter.queryLatestValues(['current_load', 'voltage']);
      const currentLoadAmpere = currentLoad / voltage;

      if (chargeState.ampere <= 0 || !chargeState.running) return;

      if (currentLoadAmpere < chargeState.ampere) {
        yield* Effect.logDebug('load power not expected', {
          currentLoad,
          voltage,
          expectedAmpere: chargeState.ampere,
        });
      }
    });

    const syncChargingRateBasedOnExcess = () => Effect.gen(function* () {
      const ampere = yield* chargingSpeedController.determineChargingSpeed(
        chargeState.running ? chargeState.ampere : 0,
      );

      yield* Effect.logDebug('Charging speed determined.', {
        current_speed: chargeState.ampere,
        determined_speed: ampere,
      });

      yield* syncAmpere(Math.min(32, ampere)).pipe(
        Effect.tap(() => Effect.annotateCurrentSpan({
          chargeState: chargeState,
          expectedAmpere: ampere,
        })),
        Effect.withSpan('syncAmpere')
      );

      yield* Effect.sleep(config.timingConfig.syncIntervalInMs).pipe(
        Effect.withSpan('syncAmpere.postWaiting')
      );

      yield* checkIfCorrectlyCharging();
    }).pipe(
      Effect.retry({
        times: 2,
        while: (err) => {
          if (err._tag !== 'VehicleAsleepError') return false;

          return Effect.sleep(Duration.millis(config.timingConfig.vehicleAwakeningTimeInMs)).pipe(
            Effect.flatMap(() => teslaClient.wakeUpCar().pipe(Effect.map(() => true))),
            Effect.catchAll((err) => Effect.log(err).pipe(Effect.map(() => false))),
          );
        },
      }),
      Effect.catchTag('VehicleAsleepError', () => Effect.fail(new VehicleNotWakingUpError({ wakeupAttempts: 2 }))),
      Effect.retry({
        times: 10,
        while: (err) => {
          if (err._tag !== 'AbruptProductionDrop') return false;
          return pipe(Effect.succeed(true), Effect.tap(() => Effect.log('AbruptProductionDropError', {
            initialProduction: err.initialProduction,
            currentProduction: err.currentProduction,
          })));
        },
      }),
      Effect.catchTag('AbruptProductionDrop', () => Effect.dieMessage('Unexpectedly got AbruptProductionDrop 10 times consecutively.')),
    );

    const stop = () => Effect.gen(function* () {
      yield* Effect.log('Stopping app and interrupting all fibers', {
        ampereFluctuations: chargeState.ampereFluctuations,
      });

      appStatus = AppStatus.Stopped;

      if (tokenRefreshFiber) {
        yield* Effect.log('Interrupting token refresh fiber');
        yield* Fiber.interrupt(tokenRefreshFiber);
      }

      if (mainSyncFiber) {
        yield* Effect.log('Interrupting main sync fiber');
        yield* Fiber.interrupt(mainSyncFiber);
      }

      if (runtimeMonitorFiber) {
        yield* Effect.log('Interrupting runtime monitor fiber');
        yield* Fiber.interrupt(runtimeMonitorFiber);
      }

      if (chargeState.running) {
        yield* Effect.retry(
          stopChargingAction(),
          {
            times: 3,
            while: (err) => {
              if (err._tag === 'VehicleAsleepError') {
                return Effect.sleep(Duration.millis(config.timingConfig.vehicleAwakeningTimeInMs)).pipe(
                  Effect.flatMap(() => teslaClient.wakeUpCar().pipe(Effect.map(() => true))),
                  Effect.catchAll((err) => Effect.log(err).pipe(Effect.map(() => false))),
                );
              }
              return true;
            }
          }
        );
      }
    }).pipe(
      Effect.catchAll((err) => {
        return Effect.fail(err).pipe(
          Effect.tap(Effect.gen(function* () {
            const netValue = (yield* dataAdapter.queryLatestValues(['daily_import'])).daily_import - chargeState.dailyImportValueAtStart;
            yield* Effect.log(`Net daily import value for session: ${netValue} kWh`);
            yield* Effect.log(`Total cost for grid import for session: $${netValue * parseFloat(process.env.COST_PER_KWH || '0.30')}`);
          }).pipe(
            Effect.catchAll(Effect.log)
          ))
        );
      }),
      Effect.orDie
    );

    const shutdownAfterMaxRuntimeHours = () => Effect.gen(function* () {
      const maxHours = config.timingConfig.maxRuntimeHours as number;
      yield* Effect.sleep(Duration.hours(maxHours));
      yield* stop();
    });

    return {
      start: () => Effect.gen(function* () {
        appStatus = AppStatus.Running;
        yield* teslaClient.refreshAccessToken();

        tokenRefreshFiber = yield* teslaClient.setupAccessTokenAutoRefreshRecurring(60 * 60 * 2)
          .pipe(Effect.flatMap(() => Effect.void))
          .pipe(Effect.fork);

        yield* Effect.sleep(1000);

        chargeState.dailyImportValueAtStart = (
          yield* dataAdapter.queryLatestValues(['daily_import'])
        ).daily_import;

        mainSyncFiber = yield* Effect.repeat(
          syncChargingRateBasedOnExcess().pipe(
            Effect.tap(() => Effect.annotateCurrentSpan({
              memory_usage_mb: memoryUsageMB(),
            })),
            Effect.withSpan('syncChargingRateBasedOnExcess'),
            Effect.map(() => appStatus)
          ),
          { while: (status) => status === AppStatus.Running }
        ).pipe(Effect.flatMap(() => Effect.void)).pipe(Effect.fork);

        if (config.timingConfig.maxRuntimeHours) {
          runtimeMonitorFiber = yield* shutdownAfterMaxRuntimeHours().pipe(Effect.fork);
        }

        yield* Fiber.joinAll([
          tokenRefreshFiber,
          ...(mainSyncFiber ? [mainSyncFiber] : []),
          ...(runtimeMonitorFiber ? [runtimeMonitorFiber] : []),
        ] as const);
      }),
      stop
    };
  })
);
