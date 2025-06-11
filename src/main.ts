import { NodeContext, NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { Effect, Logger, LogLevel } from "effect"
import { SunGatherInfluxDbDataAdapter } from './data-adapter/influx-db-sungather.data-adapter.js';
import { TeslaClient } from './tesla-client.js';
import { App } from './app.js';
import { ExcessSolarAggresiveController } from './charging-speed-controller/excess-solar-aggresive-controller.js';
import { ConservativeController } from './charging-speed-controller/conservative-controller.js';
import { ExcessFeedInSolarController } from './charging-speed-controller/excess-feed-in-solar-controller.js';
import { pino } from 'pino';
import { FixedSpeedController } from './charging-speed-controller/fixed-speed.controller.js';
import { FileSystem, HttpClient } from "@effect/platform";

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
});


const program = Effect.gen(function*() {
  const teslaClient = new TeslaClient(
    process.env.TESLA_APP_DOMAIN as string,
    process.env.TESLA_OAUTH2_CLIENT_ID as string,
    process.env.TESLA_OAUTH2_CLIENT_SECRET as string,
    yield* FileSystem.FileSystem,
    yield* HttpClient.HttpClient,
  );

  const dataAdapter = new SunGatherInfluxDbDataAdapter(
    process.env.INFLUX_URL as string,
    process.env.INFLUX_TOKEN as string,
    process.env.INFLUX_ORG as string,
    process.env.INFLUX_BUCKET as string,
    yield* HttpClient.HttpClient,
  );

  const chargingSpeedController = process.argv.includes('--fixed-lowest-speed')
  ? new FixedSpeedController(dataAdapter, { fixedSpeed: parseInt(process.env.FIXED_SPEED_AMPERE ?? '5') , bufferPower: 300 })
  : (
      process.argv.includes('--conservative')
    ? new ConservativeController(dataAdapter)
    : (
      process.argv.includes('--excess-feed-in-solar')
        ? new ExcessFeedInSolarController(dataAdapter, { maxFeedInAllowed: parseInt(process.env.MAX_ALLOWED_FEED_IN_POWER ?? '5000') })
        : new ExcessSolarAggresiveController(dataAdapter, { bufferPower: parseInt(process.env.EXCESS_SOLAR_BUFFER_POWER ?? '1000') })
    )
  );

  Effect.log(`Starting app with controller: ${chargingSpeedController.constructor.name}`);

  const app = new App(
    teslaClient,
    dataAdapter,
    chargingSpeedController,
    process.argv.includes('--dry-run'),
    logger,
  );

  yield* app.start().pipe(
    Effect.onInterrupt(() => app.stop().pipe(Effect.log)) //TODo: fix onInterrupt not triggering
  );
});

const isProd = process.env.NODE_ENV == 'production';

NodeRuntime.runMain(program.pipe(
  Logger.withMinimumLogLevel(isProd ? LogLevel.Info : LogLevel.Debug),
  Effect.provide(NodeContext.layer),
  Effect.provide(NodeHttpClient.layer),
));

process.on('unhandledRejection', async (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

