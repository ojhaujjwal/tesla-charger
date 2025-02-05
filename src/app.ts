import fs from 'node:fs';
import { promisify } from 'node:util';
import { TeslaClient } from './tesla-client.js';
import { IDataAdapter } from './data-adapter/types.js';
import { ChargingSpeedController } from './charging-speed-controller/types.js';

const delay = await promisify(setTimeout);

type ChargingState = {
  running: boolean;
  ampere: number;
  ampereFluctuations: number;
  lastCommandAt: Date | null;
  dailyImportValueAtStart: number;
};

export class App {
  private chargeState: ChargingState = {
    running: false,
    ampere: 0,
    ampereFluctuations: 0,
    lastCommandAt: null,
    dailyImportValueAtStart: 0,
  };

  public constructor(
    private readonly teslaClient: TeslaClient,
    private readonly dataAdapter: IDataAdapter<unknown>,
    private readonly chargingSpeedController: ChargingSpeedController,
    private readonly isDryRun = false,
  ) { }

  public async start() {
    // refresh access token for running tesla commands including wake up
    await this.refreshAccessToken();

    this.chargeState.dailyImportValueAtStart = await this.dataAdapter.getDailyImportValue();

    // refresh access token every "2 hours" before it expires
    setInterval(() => this.refreshAccessToken(), 1000 * 60 * 60 * 2);

    await this.syncChargingRateBasedOnExcess(5000);// every 5 seconds
  }

  public async stop() {
    console.log(`Fluctuated charging amps count: ${this.chargeState.ampereFluctuations}`);

    try {
      this.chargeState.running && await this.stopCharging();
    } catch (e) {
      console.error(e);
    } finally {
      const netValue = await this.dataAdapter.getDailyImportValue() - this.chargeState.dailyImportValueAtStart;
      console.log(`Net daily import value for session: ${netValue} kWh`);
      console.log(`Total cost for grid import for session: $${netValue * parseFloat(process.env.COST_PER_KWH || '0.30')}`);
    }
  }

  private async refreshAccessToken() {
    const accessToken = await this.teslaClient.refreshAccessToken();

    // TODO: use temp file instead
    await promisify(fs.writeFile)('.access-token', accessToken, 'utf8')
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

      const ampDifference = Math.abs(ampere - this.chargeState.ampere);

      console.log(`Setting charging rate to ${ampere}A`);

      await this.setAmpere(ampere);

      await delay(ampDifference * 2000); // 2 second for every amp difference
    }

    if (shouldStartToCharge) {
      await delay(10 * 1000); // 10 extra seconds
    }
  }

  private async syncChargingRateBasedOnExcess(retryInterval = 0) {
    const ampere = await this.chargingSpeedController.determineChargingSpeed(
      this.chargeState.running ? this.chargeState.ampere : 0,
    );

    await this.syncAmpere(Math.min(32, ampere));

    if (retryInterval > 0) {
      setTimeout(() => this.syncChargingRateBasedOnExcess(retryInterval), retryInterval);
    }
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

      await delay(5 * 1000); // 5 seconds
    }
  }

  private async startCharging() {
    await this.wakeUpCarIfNecessary();
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

