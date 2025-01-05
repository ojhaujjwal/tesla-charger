import fs from 'fs';
import { promisify } from 'util';
import { TeslaClient } from './tesla-client';
import { IDataAdapter } from './data-adapter/types';

const delay = await promisify(setTimeout);

// TODO: use ENV
const bufferPower = 200; // in watts
const VOLTAGE = 240;

type ChargingState = {
  running: boolean;
  ampere: number;
  ampereFluctuations: number;
  lastCommandAt: Date | null;
};

export class App {
  private chargeState: ChargingState = {
    running: false,
    ampere: 0,
    ampereFluctuations: 0,
    lastCommandAt: null,
  };

  public constructor(
    private readonly teslaClient: TeslaClient,
    private readonly dataAdapter: IDataAdapter<unknown>,
  ) { }

  public async start() {
    // refresh access token for running tesla commands including wake up
    await this.refreshAccessToken();

    await this.wakeUpCarIfNecessary();

    await delay(10 * 1000);

    // refresh access token every "2 hours" before it expires
    setInterval(() => this.refreshAccessToken(), 1000 * 60 * 60 * 2);

    await this.syncChargingRateBasedOnExcess(5000);// every 5 seconds
  }

  public async stop() {
    console.log(`Fluctuated charging amps count: ${this.chargeState.ampereFluctuations}`);
    this.chargeState.running && await this.stopCharging();
  }

  private async refreshAccessToken() {
    const accessToken = await this.teslaClient.refreshAccessToken();

    // TODO: use temp file instead
    await promisify(fs.writeFile)('.access-token', accessToken, 'utf8')
  }

  private async syncAmpere(ampere: number) {
    const stopCharging = ampere < 5;

    if (stopCharging && this.chargeState.running) {
      await this.stopCharging();

      await delay(1000);

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

  private async syncChargingRateBasedOnExcess(retryInterval: number = 0) {
    const exporingToGrid = await this.dataAdapter.getGridExportValue();

    console.log('exporingToGrid', exporingToGrid);

    const excessSolar = Math.min(9200, exporingToGrid - bufferPower + this.chargeState.ampere * VOLTAGE); // 9.2kW max
    excessSolar > 0 && console.log(`Excess solar: ${excessSolar}`);

    // round to nearest multiple of 5
    const ampere = Math.floor(excessSolar / VOLTAGE / 5) * 5;

    await this.syncAmpere(Math.min(32, ampere));

    if (retryInterval > 0) {
      setTimeout(() => this.syncChargingRateBasedOnExcess(retryInterval), retryInterval);
    }
  }

  private async wakeUpCarIfNecessary(): Promise<void> {
    if (null === this.chargeState.lastCommandAt) {
      return await this.teslaClient.wakeUpCar();
    }

    const secondsSinceLastCommand = (new Date().getTime() - this.chargeState.lastCommandAt.getTime()) / 1000;

    // wake up car if last command was more than 3 minutes ago
    if (secondsSinceLastCommand > (3 * 60)) {
      return await this.teslaClient.wakeUpCar();
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

