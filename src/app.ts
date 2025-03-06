import { promisify } from 'node:util';
import type { ITeslaClient } from './tesla-client.js';
import type { IDataAdapter } from './data-adapter/types.js';
import type { ChargingSpeedController } from './charging-speed-controller/types.js';
import { bufferPower } from './constants.js';
import { AbruptProductionDropError } from './errors/abrupt-production-drop.error.js';
import pRetry from 'p-retry';
import { VehicleAsleepError } from './errors/vehicle-asleep-error.js';
import type { Logger } from 'pino';
import type { IEventLogger } from './event-logger/types.js';
import { EventLogger } from './event-logger/index.js';

const delay = await promisify(setTimeout);

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

  private onAppStopCleanupCallbacks: (() => void)[] = [];

  public constructor(
    private readonly teslaClient: ITeslaClient,
    private readonly dataAdapter: IDataAdapter<unknown>,
    private readonly chargingSpeedController: ChargingSpeedController,
    private readonly isDryRun = false,
    private readonly logger: Logger,
    private readonly eventLogger: IEventLogger = new EventLogger(logger),
    private readonly timingConfig: TimingConfig = {
      syncIntervalInMs: 5000,
      vehicleAwakeningTimeInMs: 10 * 1000, // 10 seconds
      inactivityTimeInSeconds: 15 * 60, // 15 minutes
      waitPerAmereInSeconds: 2,
      extraWaitOnChargeStartInSeconds: 10, // 10 seconds
      extraWaitOnChargeStopInSeconds: 10, // 10 seconds
    },
  ) { }

  public async start() {   
    this.appStatus = AppStatus.Running;

    this.onAppStopCleanupCallbacks.push(
      // refresh access token every "2 hours" before it expires
      this.teslaClient.setupAccessTokenAutoRefresh(60 * 60 * 2)
    );

    this.chargeState.dailyImportValueAtStart = await this.dataAdapter.getDailyImportValue();

    await this.syncChargingRateBasedOnExcess();
  }

  public async stop() {
    this.logger.info(`Fluctuated charging amps count: ${this.chargeState.ampereFluctuations}`);

    this.appStatus = AppStatus.Stopped;

    try {
      this.chargeState.running && await this.stopCharging();
    } catch (e) {
      console.error(e);
    } finally {
      const netValue = await this.dataAdapter.getDailyImportValue() - this.chargeState.dailyImportValueAtStart;
      this.logger.info(`Net daily import value for session: ${netValue} kWh`);
      this.logger.info(`Total cost for grid import for session: $${netValue * parseFloat(process.env.COST_PER_KWH || '0.30')}`);
    }

    this.onAppStopCleanupCallbacks.forEach((cb) => cb());
  }

  private async syncAmpere(ampere: number) {
    const time = new Date().getTime();

    await fetch(`${process.env.INFLUX_URL}/api/v2/write?bucket=tesla_charging&org=${process.env.INFLUX_ORG}`, {
      method: 'POST',
      body: `ampere,make=tesla-model-y,year=2024 value=${ampere} ${time}`,
      headers: {
        'Authorization': `Token ${process.env.INFLUX_TOKEN}`,
      }
    });
    
    const currentProductionAtStart = await this.dataAdapter.getCurrentProduction();

    const stopCharging = ampere < 5;

    if (stopCharging && this.chargeState.running) {
      await this.stopCharging();

      await delay(this.timingConfig.extraWaitOnChargeStopInSeconds * 1000);

      return;
    }

    if (stopCharging) {
      return;
    }

    const shouldStartToCharge = !stopCharging && !this.chargeState.running;

    if (shouldStartToCharge) {
      await this.startCharging();
    }

    if (ampere !== this.chargeState.ampere) {
      const ampDifference = ampere - this.chargeState.ampere;

      this.eventLogger.onSetAmpere(ampere);

      await this.setAmpere(ampere);

      // 2 second for every amp difference
      const secondsToWait = Math.abs(ampDifference) * this.timingConfig.waitPerAmereInSeconds;

      if (ampDifference > 0) {
        await this.waitAndWatchoutForSuddenDropInProduction(
          currentProductionAtStart,
          secondsToWait 
          + (
            shouldStartToCharge ? this.timingConfig.extraWaitOnChargeStartInSeconds : 0
          )
        );
      } else {
        await delay(secondsToWait * 1000);
      }
    } else {
      this.eventLogger.onNoAmpereChange(ampere);
    }
  }

  private async waitAndWatchoutForSuddenDropInProduction(
    currentProductionAtStart: number,
    timeInSeconds: number,
  ) {
    return new Promise<void>((resolve, reject) => {
      const interval = setInterval(async () => {
        const { current_production: currentProduction, import_from_grid: importingFromGrid } = await this.dataAdapter.getValues(['current_production', 'import_from_grid']);
        this.logger.debug('watching for sudden drop in production', {
          currentProduction,
          currentProductionAtStart,
          importingFromGrid,
        });
        if (importingFromGrid > 0 || currentProduction < (currentProductionAtStart - bufferPower)) {
          clearInterval(interval);
          reject(new AbruptProductionDropError(currentProductionAtStart, currentProduction));
        }
      }, 2000);

      delay(timeInSeconds * 1000).then(() => {
        clearInterval(interval);
        resolve();
      });
    });
  }

  private async syncChargingRateBasedOnExcess() {
    this.logger.debug('syncChargingRateBasedOnExcess trigerred');
    await pRetry(async () => {
      const ampere = await this.chargingSpeedController.determineChargingSpeed(
        this.chargeState.running ? this.chargeState.ampere : 0,
      );
      await this.syncAmpere(Math.min(32, ampere));
  
      if (this.timingConfig.syncIntervalInMs > 0 && AppStatus.Running == this.appStatus) {
        setTimeout(() => this.syncChargingRateBasedOnExcess(), this.timingConfig.syncIntervalInMs);
      }
    }, {
      shouldRetry: (error) => error instanceof AbruptProductionDropError || error instanceof VehicleAsleepError,
      onFailedAttempt: async (error) => { 
        if (error instanceof AbruptProductionDropError) { 
          this.logger.info('AbruptProductionDropError', {
            initialProduction: error.initialProduction,
            currentProduction: error.currentProduction,
          });
        }

        if (error instanceof VehicleAsleepError) {
          await this.teslaClient.wakeUpCar();
          await delay(this.timingConfig.vehicleAwakeningTimeInMs);
        }
      },
      retries: 5,
      minTimeout: 50,
      factor: 2,
    });
  }

  private async startCharging() {
    if (this.chargeState.ampereFluctuations === 0) {
      try {
        // stop charging if car is already charging when program starts
        await this.teslaClient.stopCharging();
      } catch {
        // ignore if car is not charging
      }
    }

    if (this.isDryRun) {
      console.log('Starting charging');
    } else {
      await this.teslaClient.startCharging();
    }
    this.chargeState = {
      ...this.chargeState,
      running: true,
      lastCommandAt: new Date(),
    };
  }

  private async stopCharging(): Promise<void> {
    if (this.isDryRun) {
      console.log('Stopping charging');
    } else {
      await this.teslaClient.stopCharging();
    }

    this.chargeState = {
      ...this.chargeState,
      running: false,
      lastCommandAt: new Date(),
    };
  }

  private async setAmpere(ampere: number) {
    if (this.isDryRun) {
      console.log(`Setting ampere to ${ampere}`);
    } else {
      await this.teslaClient.setAmpere(ampere);
    }

    this.chargeState = {
      ...this.chargeState,
      ampereFluctuations: this.chargeState.ampereFluctuations + 1,
      ampere,
      lastCommandAt: new Date(),
    };
  }
}
