import fs from 'fs';
import { promisify } from 'util';
import { TeslaClient } from './tesla-client';
import { IDataAdapter } from './data-adapter/types';

const delay = await promisify(setTimeout);

// TODO: use ENV
const bufferPower = 500; // in watts
const VOLTAGE = 240;

export class App {
  private chargeState = {
    running: false,
    ampere: 0,
    ampereFluctuations: 0,
  };

  public constructor(
    private readonly teslaClient: TeslaClient,
    private readonly dataAdapter: IDataAdapter<unknown>,
  ) { }

  public async start() {
    // refresh access token for running tesla commands including wake up
    await this.refreshAccessToken();

    await this.teslaClient.wakeUpCar();

    await delay(10 * 1000);

    // refresh access token every "2 hours" before it expires
    setInterval(() => this.refreshAccessToken(), 1000 * 60 * 60 * 2);

    await this.syncChargingRate(5000);// every 5 seconds
  }

  public async stop() {
    console.log(`Fluctuated charging amps count: ${this.chargeState.ampereFluctuations}`);
    this.chargeState.running && await this.teslaClient.stopCharging();
  }

  private async refreshAccessToken() {
    const accessToken = await this.teslaClient.refreshAccessToken();

    // TODO: use temp file instead
    await promisify(fs.writeFile)('.access-token', accessToken, 'utf8')
  }

  private async setAmpere(ampere: number) {
    const stopCharging = ampere < 5;

    if (stopCharging && this.chargeState.running) {
      await this.teslaClient.stopCharging();
      await delay(1000);
      this.chargeState.running = false;
      return;
    }

    if (stopCharging) {
      return;
    }

    const shouldStartToCharge = !stopCharging && !this.chargeState.running;

    if (shouldStartToCharge) {
      await this.teslaClient.startCharging();
      this.chargeState.running = true;
    }

    if (ampere !== this.chargeState.ampere) {

      const ampDifference = Math.abs(ampere - this.chargeState.ampere);

      console.log(`Setting charging rate to ${ampere}A`);

      await this.teslaClient.setAmpere(ampere);
      this.chargeState.ampere = ampere;
      this.chargeState.ampereFluctuations++;

      await delay(ampDifference * 2000); // 2 second for every amp difference
    }

    if (shouldStartToCharge) {
      await delay(10 * 1000); // 10 extra seconds
    }
  }

  private async syncChargingRate(retryInterval: number = 0) {
    const exporingToGrid = await this.dataAdapter.getGridExportValue();

    console.log('exporingToGrid', exporingToGrid);

    const excessSolar = Math.min(9200, exporingToGrid - bufferPower + this.chargeState.ampere * VOLTAGE); // 9.2kW max
    excessSolar > 0 && console.log(`Excess solar: ${excessSolar}`);

    const ampere = excessSolar / VOLTAGE;

    // round to nearest multiple of 5
    const roundedAmpere = Math.floor(ampere / 5) * 5;

    await this.setAmpere(Math.min(32, roundedAmpere));

    if (retryInterval > 0) {
      setTimeout(() => this.syncChargingRate(retryInterval), retryInterval);
    }
  }
}

