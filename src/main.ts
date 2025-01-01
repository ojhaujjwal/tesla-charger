import fs from 'fs';
import { SunGatherInfluxDbDataAdapter } from './data-adapter/influx-db-sungather.data-adapter';
import { promisify } from 'util';
import { TeslaClient } from './tesla-client';

const delay = await promisify(setTimeout);

const teslaClient = new TeslaClient(
  process.env.TESLA_OAUTH2_CLIENT_ID as string,
  process.env.TESLA_OAUTH2_CLIENT_SECRET as string,
  process.env.TESLA_OAUTH2_REFRESH_TOKEN,
);

const refreshAccessToken = async () => {
  const accessToken = await teslaClient.refreshAccessToken();

  await promisify(fs.writeFile)('.access-token', accessToken, 'utf8');
};

let chargeState = {
  running: false,
  ampere: 0,
  ampereFluctuations: 0,
};

const setAmpere = async (ampere: number) => {
  const stopCharging = ampere < 5;

  if (stopCharging && chargeState.running) {
    await teslaClient.stopCharging();
    await delay(1000);
    chargeState.running = false;
    return;
  }

  if (stopCharging) {
    return;
  }

  const shouldStartToCharge = !stopCharging && !chargeState.running;

  if (shouldStartToCharge) {
    await teslaClient.startCharging();
    chargeState.running = true;
  }

  if (ampere !== chargeState.ampere) {

    const ampDifference = Math.abs(ampere - chargeState.ampere);

    console.log(`Setting charging rate to ${ampere}A`);

    await teslaClient.setAmpere(ampere);
    chargeState.ampere = ampere;
    chargeState.ampereFluctuations++;

    await delay(ampDifference * 2000); // 2 second for every amp difference
  }

  if (shouldStartToCharge) {
    await delay(10 * 1000); // 10 extra seconds
  }
};

const dataAdapter = new SunGatherInfluxDbDataAdapter(
  process.env.INFLUX_URL as string,
  process.env.INFLUX_TOKEN as string,
  process.env.INFLUX_ORG as string,
);

const bufferPower = 500; // in watts

const VOLTAGE = 240;

const syncChargingRate = async (retryInterval = 0) => { 
  const exporingToGrid = await dataAdapter.getGridExportValue();

  console.log('exporingToGrid', exporingToGrid);

  const excessSolar = Math.min(9200, exporingToGrid - bufferPower + chargeState.ampere * VOLTAGE); // 9.2kW max
  excessSolar > 0 && console.log(`Excess solar: ${excessSolar}`);

  const ampere = excessSolar / VOLTAGE;

  // round to nearest multiple of 5
  const roundedAmpere = Math.floor(ampere / 5) * 5;

  await setAmpere(Math.min(32, roundedAmpere));

  if (retryInterval > 0) {
    setTimeout(() => syncChargingRate(retryInterval), retryInterval);
  }
};

(async () => {
  await refreshAccessToken();

  await teslaClient.wakeUpCar();

  await delay(5000);

  setInterval(refreshAccessToken, 1000 * 60 * 60 * 2); // 2 hours

  await syncChargingRate(5000);// 5 seconds
})();

process.on('SIGINT', async () => {
  console.log(`Fluctuated charging amps count: ${chargeState.ampereFluctuations}`);
  try {
    chargeState.running && await teslaClient.stopCharging();
  } catch (e) {
    process.exit(1);
  }
  process.exit();
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  try {
    chargeState.running && await teslaClient.stopCharging();
  } finally {
    process.exit(1);
  }
});
