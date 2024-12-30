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

  const accessToken = (await response.json()).access_token;

  fs.writeFileSync('./.access-token', accessToken);
};

let chargeState = {
  running: true,
  ampere: 0,
  ampereFluctuations: 0,
};

const runShellCommand = async (command: string) => { 

  console.log(`Running command: ${command}`);

  // const { exec } = require('child_process');

  // await promisify(exec)(command);
}

const setAmpere = async (ampere: number) => {
  const stopCharging = ampere < 5;

  if (stopCharging && chargeState.running) {
    await runShellCommand('tesla-control charge-stop');
    chargeState.running = false;
  }

  if (!stopCharging && !chargeState.running) {
    await runShellCommand('tesla-control charge-start');
    chargeState.running = true;
  }

  if (ampere !== chargeState.ampere) {
    console.log(`Setting charging rate to ${ampere}A`);

    await runShellCommand(`tesla-control charging-set-amps ${ampere}`);
    chargeState.ampere = ampere;
    chargeState.ampereFluctuations++;
  }
};

const dataAdapter = new SunGatherInfluxDbDataAdapter(
  process.env.INFLUX_URL as string,
  process.env.INFLUX_TOKEN as string,
  process.env.INFLUX_ORG as string,
);

const syncChargingRate = async () => { 
  const excessSolar = await dataAdapter.getExcessSolar();
  console.log(`Excess solar: ${excessSolar}`);

  const bufferPower = 1000; // 1kW buffer

  const ampere = (excessSolar - bufferPower) / 240;

  // round to nearest multiple of 5
  const roundedAmpere = Math.floor(ampere / 5) * 5;

  setAmpere(Math.min(32, roundedAmpere));
};

(async () => {

  await refreshAccessToken();

  setInterval(refreshAccessToken, 1000 * 60 * 60 * 2); // 2 hours

  await syncChargingRate();

  setInterval(syncChargingRate, 1000 * 2); // 2 seconds
})();

process.on('SIGINT', async () => {
  console.log(`Fluctuated charging amps count: ${chargeState.ampereFluctuations}`);
  await runShellCommand('tesla-control charge-stop');
  process.exit();
});
