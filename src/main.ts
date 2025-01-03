import { SunGatherInfluxDbDataAdapter } from './data-adapter/influx-db-sungather.data-adapter';
import { TeslaClient } from './tesla-client';
import { App } from './app';

const teslaClient = new TeslaClient(
  process.env.TESLA_APP_DOMAIN as string,
  process.env.TESLA_OAUTH2_CLIENT_ID as string,
  process.env.TESLA_OAUTH2_CLIENT_SECRET as string,
  process.env.TESLA_OAUTH2_REFRESH_TOKEN,
);

const dataAdapter = new SunGatherInfluxDbDataAdapter(
  process.env.INFLUX_URL as string,
  process.env.INFLUX_TOKEN as string,
  process.env.INFLUX_ORG as string,
);

const app = new App(
  teslaClient,
  dataAdapter,
);

process.on('SIGINT', async () => {
  try {
    await app.stop();
  } catch (e) {
    process.exit(1);
  }
  process.exit();
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  try {
    await app.stop();
  } finally {
    process.exit(1);
  }
});

(async () => {
  await app.start();
})();
