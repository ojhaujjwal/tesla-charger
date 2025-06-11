import type { ITeslaClient } from './tesla-client.js';
import { type IDataAdapter } from './data-adapter/types.js';
import type { ChargingSpeedController } from './charging-speed-controller/types.js';
import { bufferPower } from './constants.js';
import { AbruptProductionDropError } from './errors/abrupt-production-drop.error.js';
import type { IEventLogger } from './event-logger/types.js';
import { EventLogger } from './event-logger/index.js';
import { LoadPowerLowerThanExpectedChargingSpeedError } from './errors/load_power_lower_than_expected_charging_speed_error.js';
import { Duration, Effect, Fiber, pipe, Schedule } from 'effect';

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

type TimingConfig = {
  syncIntervalInMs: number;
  vehicleAwakeningTimeInMs: number;
  inactivityTimeInSeconds: number;
  waitPerAmereInSeconds: number,
  extraWaitOnChargeStartInSeconds: number;
  extraWaitOnChargeStopInSeconds: number;
};

export class App {
  private chargeState: ChargingState = {
    running: false,
    ampere: 0,
    ampereFluctuations: 0,
    lastCommandAt: null,
    dailyImportValueAtStart: 0,
  };

  private appStatus: AppStatus = AppStatus.Pending;

  public constructor(
    private readonly teslaClient: ITeslaClient,
    private readonly dataAdapter: IDataAdapter<unknown>,
    private readonly chargingSpeedController: ChargingSpeedController,
    private readonly isDryRun = false,
    private readonly eventLogger: IEventLogger = new EventLogger(),
    private readonly timingConfig: TimingConfig = {
      syncIntervalInMs: 5000,
      vehicleAwakeningTimeInMs: 10 * 1000, // 10 seconds
      inactivityTimeInSeconds: 15 * 60, // 15 minutes
      waitPerAmereInSeconds: 2.2,
      extraWaitOnChargeStartInSeconds: 10, // 10 seconds
      extraWaitOnChargeStopInSeconds: 10, // 10 seconds
    },
  ) { }

  public start() {   
    this.appStatus = AppStatus.Running;
    const deps = this;

    return Effect.gen(function*() {
      const fiber1 = yield* deps.teslaClient.setupAccessTokenAutoRefresh(60 * 60 * 2).pipe(Effect.fork);

      yield* Effect.sleep(1000);

      deps.chargeState.dailyImportValueAtStart = (
        yield* deps.dataAdapter.queryLatestValues(['daily_import'])
      ).daily_import;

      const fiber2 = yield* Effect.repeat(
        deps.syncChargingRateBasedOnExcess().pipe(
          Effect.map(() => deps.appStatus)
      ),
        {
          while: (appStatus) => appStatus === AppStatus.Running,
        }
      ).pipe(Effect.fork);

      yield* Fiber.zip(fiber1, fiber2).pipe(Fiber.join);
    });
  }

  public stop() {
    const deps = this;

    return Effect.gen(function*() {
      yield* Effect.log('Stopping app', {
        ampereFluctuations: deps.chargeState.ampereFluctuations,
      });

      if (deps.chargeState.running) {
        yield* Effect.retry(
          deps.stopCharging(),
          {
            times: 3,
            while: (err) => {
              if (err._tag === 'VehicleAsleepError') {
                return Effect.sleep(Duration.millis(deps.timingConfig.vehicleAwakeningTimeInMs)).pipe(
                  Effect.flatMap(
                    () => deps.teslaClient.wakeUpCar().pipe(Effect.map(() => true))
                ),
                  Effect.catchAll((err) => Effect.log(err).pipe(Effect.map(() => false))),
                );
              }

              return true;
            }
          }
        );
      }

      deps.appStatus = AppStatus.Stopped;
    }).pipe(
      Effect.catchAll((err) => {        
        return Effect.fail(err).pipe(
          Effect.tap(Effect.gen(function*() {
            const netValue = (yield* deps.dataAdapter.queryLatestValues(['daily_import'])).daily_import - deps.chargeState.dailyImportValueAtStart;
            Effect.log(`Net daily import value for session: ${netValue} kWh`);
            Effect.log(`Total cost for grid import for session: $${netValue * parseFloat(process.env.COST_PER_KWH || '0.30')}`);
          }).pipe(
            Effect.catchAll(Effect.log)
          ))
        );
      })
    );
  }

  private syncAmpere(ampere: number) {
    // const time = new Date().getTime();

    // await fetch(`${process.env.INFLUX_URL}/api/v2/write?bucket=tesla_charging&org=${process.env.INFLUX_ORG}`, {
    //   method: 'POST',
    //   body: `ampere,make=tesla-model-y,year=2024 value=${ampere} ${time}`,
    //   headers: {
    //     'Authorization': `Token ${process.env.INFLUX_TOKEN}`,
    //   }
    // });


    const deps = this;

    return Effect.gen(function* () {
      const { current_load: currentProductionAtStart } = yield* deps.dataAdapter.queryLatestValues(['current_load']);

      const stopCharging = ampere < 5;

      if (stopCharging && deps.chargeState.running) {
        yield* deps.stopCharging();
        yield* Effect.sleep(
          Duration.seconds(deps.timingConfig.extraWaitOnChargeStopInSeconds)
        )

        return;
      }

      if (stopCharging) {
        return;
      }

      const shouldStartToCharge = !stopCharging && !deps.chargeState.running;

      if (shouldStartToCharge) {
        yield* deps.startCharging();
      }

      if (ampere !== deps.chargeState.ampere) {
        const ampDifference = ampere - deps.chargeState.ampere;

        yield* deps.eventLogger.onSetAmpere(ampere);

        yield* deps.setAmpere(ampere);

        // 2 second for every amp difference
        const secondsToWait = Math.abs(ampDifference) * deps.timingConfig.waitPerAmereInSeconds;

        if (ampDifference > 0) {
          yield * deps.waitAndWatchoutForSuddenDropInProduction(
            currentProductionAtStart,
            secondsToWait 
            + (
              shouldStartToCharge ? deps.timingConfig.extraWaitOnChargeStartInSeconds : 0
            )
          );
        } else {
          yield* Effect.sleep(
            Duration.seconds(secondsToWait)
          )
        }
      } else {
        yield* deps.eventLogger.onNoAmpereChange(ampere);
      }
    });
  }

  /**
   * Check if load_power is abnormal or not being reflected; maybe the car is not charging.
   */
  private checkIfCorrectlyCharging()
  {
    const deps = this;
    return Effect.gen(function*() {
      const { current_load: currentLoad, voltage } = yield* deps.dataAdapter.queryLatestValues(['current_load', 'voltage']);
      const currentLoadAmpere = currentLoad / voltage;

      if (deps.chargeState.ampere <=0 || !deps.chargeState.running) {
        return;
      }

      if (currentLoadAmpere < deps.chargeState.ampere) {
        yield* Effect.logDebug('load power not expected', {
          currentLoad,
          voltage,
          expectedAmpere: deps.chargeState.ampere,
        });
        yield* Effect.fail(new LoadPowerLowerThanExpectedChargingSpeedError());
      }
    })
  }

  private waitAndWatchoutForSuddenDropInProduction(
    currentProductionAtStart: number,
    timeInSeconds: number,
  ) {

    const dataAdapter = this.dataAdapter;

    return Effect.race(
      Effect.void.pipe(Effect.delay(Duration.seconds(timeInSeconds))),
      Effect.repeat(Effect.gen(function*() {
          const { 
            current_production: currentProduction, 
            import_from_grid: importingFromGrid 
          }  = yield* dataAdapter.queryLatestValues(['current_production', 'import_from_grid']);

          yield* Effect.logDebug('watching for sudden drop in production', {
            currentProduction,
            currentProductionAtStart,
            importingFromGrid,
          });
          if (importingFromGrid > 0 || currentProduction < (currentProductionAtStart - bufferPower)) {
            yield* Effect.fail(new AbruptProductionDropError({ initialProduction: currentProductionAtStart, currentProduction}));
          }

          return Effect.void;
        }), Schedule.fixed(Duration.seconds(2)), // every 2 seonds
      )
    );
  }

  private syncChargingRateBasedOnExcess() {
    const deps = this;
    
    return Effect.retry(
      Effect.gen(function*() {
        const ampere = yield* deps.chargingSpeedController.determineChargingSpeed(
          deps.chargeState.running ? deps.chargeState.ampere : 0,
        );

        yield* Effect.logDebug('Charging speed determined.', {
          current_speed: deps.chargeState.ampere,
          determined_speed: ampere,
        });

        yield* deps.syncAmpere(Math.min(32, ampere));

        yield* Effect.sleep(deps.timingConfig.syncIntervalInMs);

        yield* deps.checkIfCorrectlyCharging();
      }),
      {
        while: (err) => {
          if (err._tag === 'VehicleAsleepError') {
            return Effect.sleep(Duration.millis(this.timingConfig.vehicleAwakeningTimeInMs)).pipe(
              Effect.flatMap(
                () => deps.teslaClient.wakeUpCar().pipe(Effect.map(() => true))
            ),
              Effect.catchAll((err) => Effect.log(err).pipe(Effect.map(() => false))),
            );
          }

          if (err._tag !== 'AbruptProductionDrop') {
            return Effect.succeed(false);
          }

          return pipe(Effect.succeed(true), Effect.tap(() => Effect.log('AbruptProductionDropError', {
            initialProduction: err.initialProduction,
            currentProduction: err.currentProduction,
          })));
        },
        schedule: Schedule.exponential(Duration.millis(50), 2),
        times: 5,
      }
    );
  }

  private startCharging() {
    return (this.isDryRun ? Effect.log('Starting charging') : this.teslaClient.startCharging())
      .pipe(
        Effect.tap(() => {
          this.chargeState = {
            ...this.chargeState,
            running: true,
            lastCommandAt: new Date(),
          };
        })
      )
  }

  private stopCharging() { 
    return (this.isDryRun ? Effect.log('Stopping charging') : this.teslaClient.stopCharging())
      .pipe(
        Effect.tap(() => {
          this.chargeState = {
            ...this.chargeState,
            ampere: 0,
            running: false,
            lastCommandAt: new Date(),
          };
        })
      )
  }

  private setAmpere(ampere: number) {
    return (this.isDryRun ? Effect.log(`Setting ampere to ${ampere}`) : this.teslaClient.setAmpere(ampere))
      .pipe(
        Effect.tap(() => {
          this.chargeState = {
            ...this.chargeState,
            ampere,
            lastCommandAt: new Date(),
          };
        })
      )
  }
}
