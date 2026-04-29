import { NodeContext, NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Cause, Chunk, Config, Effect, Layer, Logger, LogLevel, Option } from "effect";
import { AppConfig } from "./config.js";
import { createTeslaClientLayer } from "./layers.js";
import { App, AppLayer, type TimingConfig } from "./app.js";
import { BatteryStateManagerLayer } from "./battery-state-manager.js";
import { FixedSpeedControllerLayer } from "./charging-speed-controller/fixed-speed.controller.js";
import { ConservativeControllerLayer } from "./charging-speed-controller/conservative-controller.js";
import { ExcessFeedInSolarControllerLayer } from "./charging-speed-controller/excess-feed-in-solar-controller.js";
import { ExcessSolarAggresiveControllerLayer } from "./charging-speed-controller/excess-solar-aggresive-controller.js";
import { ExcessSolarNonAggresiveControllerLayer } from "./charging-speed-controller/excess-solar-non-aggresive.controller.js";
import { WeatherAwareBufferControllerLayer } from "./charging-speed-controller/weather-aware-buffer/index.js";
import { SolcastForecastLayer } from "./solar-forecast/solcast.adapter.js";
import { SentryLive, SentryFlushFiber, flushSentry, captureException, initSentry } from "./sentry.js";
import * as SentryCore from "@sentry/core";
import { serviceLayers } from "./layers.js";

// Initialize Sentry before building Effect layers
initSentry();

const maxRuntimeHours = process.argv.includes("--max-runtime-hours")
  ? parseInt(process.argv[process.argv.indexOf("--max-runtime-hours") + 1])
  : undefined;

const timingConfigBase = {
  syncIntervalInMs: 5000,
  vehicleAwakeningTimeInMs: 10 * 1000,
  inactivityTimeInSeconds: 15 * 60,
  waitPerAmereInSeconds: 2.2,
  extraWaitOnChargeStartInSeconds: 10,
  extraWaitOnChargeStopInSeconds: 10
};

const MainLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const timingConfig: TimingConfig = {
      ...timingConfigBase,
      ...(maxRuntimeHours !== undefined && { maxRuntimeHours })
    };

    const teslaAppDomain = yield* AppConfig.tesla.appDomain;
    const teslaClientId = yield* AppConfig.tesla.oauth2ClientId;
    const teslaClientSecret = yield* AppConfig.tesla.oauth2ClientSecret;
    const teslaVin = yield* AppConfig.tesla.vin;
    const costPerKwh = yield* AppConfig.cost.perKwh;

    let controllerLayer;

    if (process.argv.includes("--fixed-lowest-speed")) {
      const fixedSpeed = yield* AppConfig.controller.fixedSpeedAmpere;
      controllerLayer = FixedSpeedControllerLayer({ fixedSpeed, bufferPower: 300 });
    } else if (process.argv.includes("--conservative")) {
      controllerLayer = ConservativeControllerLayer();
    } else if (process.argv.includes("--excess-feed-in-solar")) {
      const maxFeedInAllowed = yield* AppConfig.controller.maxAllowedFeedInPower;
      controllerLayer = ExcessFeedInSolarControllerLayer({ maxFeedInAllowed });
    } else if (process.argv.includes("--weather-aware")) {
      const minBufferPower = yield* AppConfig.weatherAware.minBufferPower;
      const bufferMultiplierMax = yield* AppConfig.weatherAware.bufferMultiplierMax;
      const carBatteryCapacityKwh = yield* AppConfig.weatherAware.carBatteryCapacityKwh;
      const peakSolarCapacityKw = yield* AppConfig.weatherAware.peakSolarCapacityKw;
      const latitude = yield* AppConfig.weatherAware.latitude;
      const longitude = yield* AppConfig.weatherAware.longitude;
      const defaultDailyProductionKwh = yield* AppConfig.weatherAware.defaultDailyProductionKwh;
      const solarCutoffHour = yield* AppConfig.weatherAware.solarCutoffHour;
      const deadlineHourOption = yield* Effect.option(AppConfig.weatherAware.deadlineHour);

      const solcastApiKey = yield* AppConfig.solcast.apiKey;
      const solcastRooftopResourceId = yield* AppConfig.solcast.rooftopResourceId;

      controllerLayer = WeatherAwareBufferControllerLayer({
        minBufferPower,
        bufferMultiplierMax,
        carBatteryCapacityKwh,
        peakSolarCapacityKw,
        latitude,
        longitude,
        defaultDailyProductionKwh,
        solarCutoffHour,
        multipleOf: 3,
        ...(Option.isSome(deadlineHourOption) && { deadlineHour: deadlineHourOption.value })
      }).pipe(
        Layer.provide(
          SolcastForecastLayer({
            apiKey: solcastApiKey,
            rooftopResourceId: solcastRooftopResourceId
          })
        )
      );
    } else {
      const bufferPower = yield* AppConfig.excessSolar.bufferPower;
      controllerLayer = ExcessSolarNonAggresiveControllerLayer({
        baseControllerLayer: ExcessSolarAggresiveControllerLayer({
          bufferPower,
          multipleOf: 3
        })
      });
    }

    const teslaLayer = createTeslaClientLayer({
      appDomain: teslaAppDomain,
      clientId: teslaClientId,
      clientSecret: teslaClientSecret,
      vin: teslaVin
    });

    return AppLayer({
      timingConfig,
      isDryRun: process.argv.includes("--dry-run"),
      costPerKwh
    }).pipe(
      Layer.provideMerge(controllerLayer),
      Layer.provideMerge(BatteryStateManagerLayer),
      Layer.provideMerge(serviceLayers),
      Layer.provideMerge(teslaLayer),
      Layer.provideMerge(SentryLive),
      Layer.provideMerge(NodeContext.layer),
      Layer.provideMerge(NodeHttpClient.layer)
    );
  })
);

const program = Effect.gen(function* () {
  const app = yield* App;

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* app.stop();
      yield* Effect.logInfo("Finalizing, flushing Sentry...");
      yield* flushSentry().pipe(Effect.catchAll(() => Effect.logDebug("Sentry flush timed out")));
    })
  );

  yield* Effect.fork(SentryFlushFiber);

  yield* app.start().pipe(
    Effect.catchAll((err) =>
      Effect.log(err).pipe(
        Effect.tap(() => captureException(err)),
        Effect.flatMap(() => app.stop())
      )
    )
  );
}).pipe(Effect.provide(MainLayer), Effect.scoped);

const runProgram = Effect.gen(function* () {
  const nodeEnv = yield* Config.string("NODE_ENV").pipe(Config.withDefault("production"));
  return yield* program.pipe(Logger.withMinimumLogLevel(nodeEnv === "production" ? LogLevel.Info : LogLevel.Debug));
}).pipe(
  Effect.tapDefect((cause) =>
    Effect.sync(() => {
      const defects = Chunk.toReadonlyArray(Cause.defects(cause));
      for (const defect of defects) {
        SentryCore.captureException(defect);
      }
      if (defects.length === 0) {
        SentryCore.captureException(new Error(Cause.pretty(cause)));
      }
    })
  )
);

// 3. Execution
NodeRuntime.runMain(runProgram, { disablePrettyLogger: true });

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  SentryCore.captureException(reason);
  void SentryCore.flush(5000).then(() => process.exit(1));
});
