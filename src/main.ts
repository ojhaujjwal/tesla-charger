import { SunGatherInfluxDbDataAdapter } from './data-adapter/influx-db-sungather.data-adapter.js';
import { TeslaClient } from './tesla-client.js';
import { App } from './app.js';
import { ExcessSolarAggresiveController } from './charging-speed-controller/excess-solar-aggresive-controller.js';
import { ConservativeController } from './charging-speed-controller/conservative-controller.js';
import { ExcessFeedInSolarController } from './charging-speed-controller/excess-feed-in-solar-controller.js';
import { pino } from 'pino';
import { FixedSpeedController } from './charging-speed-controller/fixed-speed.controller.js';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
});

const teslaClient = new TeslaClient(
  process.env.TESLA_APP_DOMAIN as string,
  process.env.TESLA_OAUTH2_CLIENT_ID as string,
  process.env.TESLA_OAUTH2_CLIENT_SECRET as string,
);

const dataAdapter = new SunGatherInfluxDbDataAdapter(
  process.env.INFLUX_URL as string,
  process.env.INFLUX_TOKEN as string,
  process.env.INFLUX_ORG as string,
  process.env.INFLUX_BUCKET as string,
);

const chargingSpeedController = process.argv.includes('--fixed-lowest-speed')
  ? new FixedSpeedController(dataAdapter, { fixedSpeed: parseInt(process.env.FIXED_SPEED_AMPERE ?? '5') , bufferPower: 300 })
  : (
      process.argv.includes('--conservative')
    ? new ConservativeController(dataAdapter)
    : (
      process.argv.includes('--excess-feed-in-solar')
        ? new ExcessFeedInSolarController(dataAdapter, { maxFeedInAllowed: parseInt(process.env.MAX_ALLOWED_FEED_IN_POWER ?? '5000') })
        : new ExcessSolarAggresiveController(dataAdapter, logger, { bufferPower: parseInt(process.env.EXCESS_SOLAR_BUFFER_POWER ?? '1000') })
    )
  );

logger.info(`Starting app with controller: ${chargingSpeedController.constructor.name}`);

const app = new App(
  teslaClient,
  dataAdapter,
  chargingSpeedController,
  process.argv.includes('--dry-run'),
  logger,
);

process.on('SIGINT', async () => {
  try {
    await app.stop();
  } catch (e) {
    console.error(e);
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
