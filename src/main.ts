import fs from 'fs';
import { SunGatherInfluxDbDataAdapter } from './data-adapter/influx-db-sungather.data-adapter';
import { exec } from 'child_process';
import { promisify } from 'util';

const refreshAccessToken = async () => {
  const response = await fetch('https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token', {
    method: 'POST',
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: process.env.TESLA_OAUTH2_CLIENT_ID,
      refresh_token: process.env.TESLA_OAUTH2_REFRESH_TOKEN,
    }),
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to refresh access token: ${response.statusText} response: ${await response.text()}`);
  }

  const accessToken = (await response.json()).access_token;

  fs.writeFileSync('./.access-token', accessToken);
};

let chargeState = {
  running: false,
  ampere: 0,
  ampereFluctuations: 0,
};

const runShellCommand = async (command: string) => { 

  console.log(`Running command: ${command}`);

  await promisify(exec)(command);
}

const setAmpere = async (ampere: number) => {
  const stopCharging = ampere < 5;

  if (stopCharging && chargeState.running) {
    await runShellCommand('tesla-control charging-stop');
    await promisify(setTimeout)(1000);
    chargeState.running = false;
    return;
  }

  if (stopCharging) {
    return;
  }

  const shouldStartToCharge = !stopCharging && !chargeState.running;

  if (shouldStartToCharge) {
    await runShellCommand('tesla-control charging-start');
    chargeState.running = true;
  }

  if (ampere !== chargeState.ampere) {

    const ampDifference = Math.abs(ampere - chargeState.ampere);

    console.log(`Setting charging rate to ${ampere}A`);

    await runShellCommand(`tesla-control charging-set-amps ${ampere}`);
    chargeState.ampere = ampere;
    chargeState.ampereFluctuations++;

    await promisify(setTimeout)(ampDifference * 2000); // 2 second for every amp difference
  }

  if (shouldStartToCharge) {
    await promisify(setTimeout)(10 * 1000); // 10 extra seconds
  }
};

const dataAdapter = new SunGatherInfluxDbDataAdapter(
  process.env.INFLUX_URL as string,
  process.env.INFLUX_TOKEN as string,
  process.env.INFLUX_ORG as string,
);

const bufferPower = 1000; // in watts

const VOLTAGE = 240;

const syncChargingRate = async (retryInterval = 0) => { 
  const exporingToGrid = await dataAdapter.getGridExportValue();

  console.log('exporingToGrid', exporingToGrid);

  const excessSolar = Math.min(9200, exporingToGrid - bufferPower + chargeState.ampere * VOLTAGE); // 9.2kW max
  console.log(`Excess solar: ${excessSolar}`);

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

  setInterval(refreshAccessToken, 1000 * 60 * 60 * 2); // 2 hours

  await syncChargingRate(5000);// 5 seconds
})();

process.on('SIGINT', async () => {
  console.log(`Fluctuated charging amps count: ${chargeState.ampereFluctuations}`);
  try {
    chargeState.running && await runShellCommand('tesla-control charging-stop');
  } catch (e) {
    process.exit(1);
  }
  process.exit();
});


process.on('unhandledRejection', async (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  try {
    chargeState.running && await runShellCommand('tesla-control charging-stop');
  } finally {
    process.exit(1);
  }
});
