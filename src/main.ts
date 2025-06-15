import { NodeContext, NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { Effect, Logger, LogLevel } from "effect"
import { TeslaClient } from './tesla-client/index.js';
import { App } from './app.js';
import { ExcessSolarAggresiveController } from './charging-speed-controller/excess-solar-aggresive-controller.js';
import { ConservativeController } from './charging-speed-controller/conservative-controller.js';
import { ExcessFeedInSolarController } from './charging-speed-controller/excess-feed-in-solar-controller.js';
import { FixedSpeedController } from './charging-speed-controller/fixed-speed.controller.js';
import { FileSystem, HttpClient } from "@effect/platform";
import { NodeSdk } from "@effect/opentelemetry"
import { SentrySpanProcessor } from "@sentry/opentelemetry";
import * as Sentry from "@sentry/node";
import { DataAdapter } from "data-adapter/types.js";
import { serviceLayers } from "layers.js";

const isProd = process.env.NODE_ENV == 'production';

Sentry.init({
  dsn: process.env.SENTRY_DSN as string,
  tracesSampleRate: 1.0,
});


const NodeSdkLive = NodeSdk.layer(() => ({
  resource: { serviceName: "tesla-charger" },
  spanProcessor: new SentrySpanProcessor()
}))


const program = Effect.gen(function*() {
  const teslaClient = new TeslaClient(
    process.env.TESLA_APP_DOMAIN as string,
    process.env.TESLA_OAUTH2_CLIENT_ID as string,
    process.env.TESLA_OAUTH2_CLIENT_SECRET as string,
    yield* FileSystem.FileSystem,
    yield* HttpClient.HttpClient,
  );

  const dataAdapter = yield* DataAdapter;

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
  );

  yield* Effect.addFinalizer(() => app.stop().pipe(Effect.catchAll(err => Effect.log(err))));

  yield* app.start().pipe(
    Effect.catchAll(err => Effect.log(err).pipe(Effect.flatMap(() => app.stop()))),
    Effect.catchAll(err => Effect.log(err)),
  );
}).pipe(
  Effect.provide(serviceLayers),
  Effect.provide(NodeSdkLive),
  Effect.provide(NodeContext.layer),
  Effect.provide(NodeHttpClient.layer),
  Effect.scoped,
  Logger.withMinimumLogLevel(isProd ? LogLevel.Info : LogLevel.Debug),
);
NodeRuntime.runMain(program);

process.on('unhandledRejection', async (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

