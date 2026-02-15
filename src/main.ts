import { NodeContext, NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { Cause, Chunk, Effect, Layer, Logger, LogLevel } from "effect"
import { createTeslaClientLayer } from './layers.js';
import { App, AppLayer, type TimingConfig } from './app.js';
import { BatteryStateManagerLayer } from './battery-state-manager.js';
import { FixedSpeedControllerLayer } from './charging-speed-controller/fixed-speed.controller.js';
import { ConservativeControllerLayer } from './charging-speed-controller/conservative-controller.js';
import { ExcessFeedInSolarControllerLayer } from './charging-speed-controller/excess-feed-in-solar-controller.js';
import { ExcessSolarAggresiveControllerLayer } from './charging-speed-controller/excess-solar-aggresive-controller.js';
import { ExcessSolarNonAggresiveControllerLayer } from './charging-speed-controller/excess-solar-non-aggresive.controller.js';
import { WeatherAwareBufferControllerLayer } from './charging-speed-controller/weather-aware-buffer/index.js';
import { SolcastForecastLayer } from './solar-forecast/solcast.adapter.js';
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
  if (process.argv.includes('--weather-aware')) {
    return WeatherAwareBufferControllerLayer({
      minBufferPower: parseInt(process.env.EXCESS_SOLAR_BUFFER_POWER ?? '500'),
      bufferMultiplierMax: parseFloat(process.env.BUFFER_MULTIPLIER_MAX ?? '3'),
      carBatteryCapacityKwh: parseFloat(process.env.CAR_BATTERY_CAPACITY_KWH ?? '60'),
      peakSolarCapacityKw: parseFloat(process.env.SOLCAST_CAPACITY_KW ?? '9'),
      latitude: parseFloat(process.env.SOLCAST_LATITUDE as string),
      longitude: parseFloat(process.env.SOLCAST_LONGITUDE as string),
      defaultDailyProductionKwh: parseFloat(process.env.DEFAULT_DAILY_PRODUCTION_KWH ?? '60'),
      solarCutoffHour: parseInt(process.env.SOLAR_CUTOFF_HOUR ?? '18'),
      multipleOf: 3,
      ...(process.env.DEADLINE_HOUR && { deadlineHour: parseInt(process.env.DEADLINE_HOUR) }),
    }).pipe(
      Layer.provide(SolcastForecastLayer({
        apiKey: process.env.SOLCAST_API_KEY as string,
        latitude: parseFloat(process.env.SOLCAST_LATITUDE as string),
        longitude: parseFloat(process.env.SOLCAST_LONGITUDE as string),
        capacityKw: parseFloat(process.env.SOLCAST_CAPACITY_KW as string),
      })),
    );
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
    Effect.catchAll(err => Effect.log(err).pipe(
      Effect.tap(() => Effect.sync(() => Sentry.captureException(err))),
      Effect.flatMap(() => app.stop()),
    )),
    Effect.catchAll(err => Effect.log(err).pipe(
      Effect.tap(() => Effect.sync(() => Sentry.captureException(err))),
    )),
  );
}).pipe(
  Effect.provide(
    AppLayer({
      timingConfig,
      isDryRun: process.argv.includes('--dry-run'),
    }).pipe(
      Layer.provideMerge(createChargingSpeedControllerLayer()),
      Layer.provideMerge(BatteryStateManagerLayer),
      Layer.provideMerge(serviceLayers),
      Layer.provideMerge(
        createTeslaClientLayer({
          appDomain: process.env.TESLA_APP_DOMAIN as string,
          clientId: process.env.TESLA_OAUTH2_CLIENT_ID as string,
          clientSecret: process.env.TESLA_OAUTH2_CLIENT_SECRET as string,
          vin: process.env.TESLA_VIN as string,
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
  Effect.tapDefect((cause) => Effect.sync(() => {
    const defects = Chunk.toReadonlyArray(Cause.defects(cause));
    for (const defect of defects) {
      Sentry.captureException(defect);
    }
    if (defects.length === 0) {
      Sentry.captureException(new Error(Cause.pretty(cause)));
    }
  })),
);

// 3. Execution
NodeRuntime.runMain(program);

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  Sentry.captureException(reason);
  void Sentry.flush(2000).then(() => process.exit(1));
});

