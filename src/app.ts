import { promisify } from 'node:util';
import { ITeslaClient } from './tesla-client.js';
import { IDataAdapter } from './data-adapter/types.js';
import { ChargingSpeedController } from './charging-speed-controller/types.js';
import { bufferPower } from './constants.js';
import { AbruptProductionDrop } from './errors/abrupt-production-drop.js';
import pRetry from 'p-retry';

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
    private readonly syncInterval = 5000,
    private readonly isDryRun = false,
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
    console.log(`Fluctuated charging amps count: ${this.chargeState.ampereFluctuations}`);

    this.appStatus = AppStatus.Stopped;

    try {
      this.chargeState.running && await this.stopCharging();
    } catch (e) {
      console.error(e);
    } finally {
      const netValue = await this.dataAdapter.getDailyImportValue() - this.chargeState.dailyImportValueAtStart;
      console.log(`Net daily import value for session: ${netValue} kWh`);
      console.log(`Total cost for grid import for session: $${netValue * parseFloat(process.env.COST_PER_KWH || '0.30')}`);
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

    const stopCharging = ampere < 5;

    if (stopCharging && this.chargeState.running) {
      await this.stopCharging();

      await delay(10000);

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

      console.log(`Setting charging rate to ${ampere}A`);

      await this.setAmpere(ampere);

      // 2 second for every amp difference
      const secondsToWait = Math.abs(ampDifference) * 2;

      if (ampDifference > 0) {
        await this.waitAndWatchoutForSuddenDropInProduction(secondsToWait);
      } else {
        await delay(secondsToWait * 1000);
      }
    }

    if (shouldStartToCharge) {
      await delay(10 * 1000); // 10 extra seconds
    }
  }

  private async waitAndWatchoutForSuddenDropInProduction(timeInSeconds: number) {
    const currentProductionAtStart = await this.dataAdapter.getCurrentProduction();

    return new Promise<void>((resolve, reject) => {
      //const start= new Date().getTime();
      const interval = setInterval(async () => {
        const currentProduction = await this.dataAdapter.getCurrentProduction();
        console.log('watching for sudden drop in production', {
          currentProduction,
          currentProductionAtStart,
        });
        if (currentProduction < (currentProductionAtStart - bufferPower)) {
          clearInterval(interval);
          reject(new AbruptProductionDrop());
        }
      }, 2000);

      delay(timeInSeconds * 1000).then(() => {
        clearInterval(interval);
        resolve();
      });
    });
  }

  private async syncChargingRateBasedOnExcess() {
    await pRetry(async () => {
      const ampere = await this.chargingSpeedController.determineChargingSpeed(
        this.chargeState.running ? this.chargeState.ampere : 0,
      );
      await this.syncAmpere(Math.min(32, ampere));
  
      if (this.syncInterval > 0 && AppStatus.Running == this.appStatus) {
        setTimeout(() => this.syncChargingRateBasedOnExcess(), this.syncInterval);
      }
    }, {
      shouldRetry: (error) => error instanceof AbruptProductionDrop,
      retries: 10,
    });
  }

  private async wakeUpCarIfNecessary(): Promise<void> {
    if (null === this.chargeState.lastCommandAt) {
      if (this.isDryRun) {
        console.log('Waking up car for the first time');
      } else {
        await this.teslaClient.wakeUpCar();
      }
      await delay(10 * 1000); // 10 seconds
      return;
    }

    const secondsSinceLastCommand = (new Date().getTime() - this.chargeState.lastCommandAt.getTime()) / 1000;

    // wake up car if last command was more than 3 minutes ago
    if (secondsSinceLastCommand > (3 * 60)) {

      if (this.isDryRun) {
        console.log('Waking up car after idle activity');
      } else {
        await this.teslaClient.wakeUpCar();
      }

      await delay(10 * 1000); // 5 seconds
    }
  }

  private async startCharging() {
    await this.wakeUpCarIfNecessary();

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
    await this.wakeUpCarIfNecessary();

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
    await this.wakeUpCarIfNecessary();

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
