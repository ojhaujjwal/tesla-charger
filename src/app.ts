import fs from 'fs';
import { promisify } from 'util';
import { TeslaClient } from './tesla-client';
import { IDataAdapter } from './data-adapter/types';

const delay = await promisify(setTimeout);

// TODO: use ENV
const bufferPower = 500; // in watts
const VOLTAGE = 240;

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
  ) { }

  public async start() {
    // refresh access token for running tesla commands including wake up
    await this.refreshAccessToken();

    await this.wakeUpCarIfNecessary();

    await Promise.all([
      delay(10 * 1000),
      // record daily import value at start to measure net import value 
      // at the end of the program
      this.dataAdapter.getDailyImportValue()
        .then((value) => this.chargeState.dailyImportValueAtStart = value),
    ]);

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
    const exporingToGrid = await this.dataAdapter.getGridExportValue();

    console.log('exporingToGrid', exporingToGrid);

    const excessSolar = Math.min(9200, exporingToGrid - bufferPower + this.chargeState.ampere * VOLTAGE); // 9.2kW max
    
    if (excessSolar > 0) {
      console.log(`Excess solar: ${excessSolar}`);
    }

    // round to nearest multiple of 5
    const ampere = Math.floor(excessSolar / VOLTAGE / 5) * 5;

    await this.syncAmpere(Math.min(32, ampere));

    if (retryInterval > 0) {
      setTimeout(() => this.syncChargingRateBasedOnExcess(retryInterval), retryInterval);
    }
  }

  private async wakeUpCarIfNecessary(): Promise<void> {
    if (null === this.chargeState.lastCommandAt) {
      await this.teslaClient.wakeUpCar();
      await delay(5 * 1000); // 5 seconds
      return;
    }

    const secondsSinceLastCommand = (new Date().getTime() - this.chargeState.lastCommandAt.getTime()) / 1000;

    // wake up car if last command was more than 3 minutes ago
    if (secondsSinceLastCommand > (3 * 60)) {
      await this.teslaClient.wakeUpCar();
      await delay(5 * 1000); // 5 seconds
    }
  }

  private async startCharging() {
    await this.wakeUpCarIfNecessary();
    await this.teslaClient.startCharging();
    this.chargeState = {
      ...this.chargeState,
      running: true,
      lastCommandAt: new Date(),
    };
  }

  private async stopCharging() {
    await this.wakeUpCarIfNecessary();
    await this.teslaClient.stopCharging();
    this.chargeState = {
      ...this.chargeState,
      running: false,
      lastCommandAt: new Date(),
    };
  }

  private async setAmpere(ampere: number) {
    await this.wakeUpCarIfNecessary();
    await this.teslaClient.setAmpere(ampere);
    this.chargeState = {
      ...this.chargeState,
      ampereFluctuations: this.chargeState.ampereFluctuations + 1,
      ampere,
      lastCommandAt: new Date(),
    };
  }
}

