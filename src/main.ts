import { NodeContext, NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Logger, LogLevel } from "effect"
import { createTeslaClientLayer } from './layers.js';
import { App, AppLayer, type TimingConfig } from './app.js';
import { FixedSpeedControllerLayer } from './charging-speed-controller/fixed-speed.controller.js';
import { ConservativeControllerLayer } from './charging-speed-controller/conservative-controller.js';
import { ExcessFeedInSolarControllerLayer } from './charging-speed-controller/excess-feed-in-solar-controller.js';
import { ExcessSolarAggresiveControllerLayer } from './charging-speed-controller/excess-solar-aggresive-controller.js';
import { ExcessSolarNonAggresiveControllerLayer } from 'charging-speed-controller/excess-solar-non-aggresive.controller.js';
import { NodeSdk as EffectOpenTelemetryNodeSdk } from "@effect/opentelemetry"
import { SentrySpanProcessor } from "@sentry/opentelemetry";
import * as Sentry from "@sentry/node";
import { serviceLayers } from "./layers.js";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"

const isProd = process.env.NODE_ENV == 'production';

Sentry.init({
  dsn: process.env.SENTRY_DSN as string,
  tracesSampleRate: 1.0,
});

const maxRuntimeHours = process.argv.includes('--max-runtime-hours')
  ? parseInt(process.argv[process.argv.indexOf('--max-runtime-hours') + 1])
  : undefined;

const timingConfig: TimingConfig = {
  syncIntervalInMs: 5000,
  vehicleAwakeningTimeInMs: 10 * 1000,
  inactivityTimeInSeconds: 15 * 60,
  waitPerAmereInSeconds: 2.2,
  extraWaitOnChargeStartInSeconds: 10,
  extraWaitOnChargeStopInSeconds: 10,
  ...(maxRuntimeHours !== undefined && { maxRuntimeHours }),
};

const createChargingSpeedControllerLayer = () => {
  if (process.argv.includes('--fixed-lowest-speed')) {
    return FixedSpeedControllerLayer({
      fixedSpeed: parseInt(process.env.FIXED_SPEED_AMPERE ?? '5'),
      bufferPower: 300
    });
  }
  if (process.argv.includes('--conservative')) {
    return ConservativeControllerLayer();
  }
  if (process.argv.includes('--excess-feed-in-solar')) {
    return ExcessFeedInSolarControllerLayer({
      maxFeedInAllowed: parseInt(process.env.MAX_ALLOWED_FEED_IN_POWER ?? '5000')
    });
  }
  // Default: ExcessSolarNonAggresive wrapping ExcessSolarAggresive
  return ExcessSolarNonAggresiveControllerLayer({
    baseControllerLayer: ExcessSolarAggresiveControllerLayer({
      bufferPower: parseInt(process.env.EXCESS_SOLAR_BUFFER_POWER ?? '1000'),
      multipleOf: 3
    })
  });
};

const program = Effect.gen(function* () {
  const app = yield* App;

  yield* Effect.addFinalizer(() => app.stop());

  yield* app.start().pipe(
    Effect.catchAll(err => Effect.log(err).pipe(Effect.flatMap(() => app.stop()))),
    Effect.catchAll(err => Effect.log(err)),
  );
}).pipe(
  Effect.provide(
    AppLayer({
      timingConfig,
      isDryRun: process.argv.includes('--dry-run'),
    }).pipe(
      Layer.provideMerge(createChargingSpeedControllerLayer()),
      Layer.provideMerge(serviceLayers),
      Layer.provideMerge(
        createTeslaClientLayer({
          appDomain: process.env.TESLA_APP_DOMAIN as string,
          clientId: process.env.TESLA_OAUTH2_CLIENT_ID as string,
          clientSecret: process.env.TESLA_OAUTH2_CLIENT_SECRET as string,
        })
      ),
      Layer.provideMerge(
        EffectOpenTelemetryNodeSdk.layer(() => ({
          resource: { serviceName: "tesla-charger" },
          spanProcessor: [
            new SentrySpanProcessor(),
            new BatchSpanProcessor(new OTLPTraceExporter())
          ]
        }))
      ),
      Layer.provideMerge(NodeContext.layer),
      Layer.provideMerge(NodeHttpClient.layer),
    )
  ),
  Effect.scoped,
  Logger.withMinimumLogLevel(isProd ? LogLevel.Info : LogLevel.Debug),
  Effect.orDie
);

// 3. Execution
NodeRuntime.runMain(program);

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

