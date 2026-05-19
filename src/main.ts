import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, Layer, Option, Redacted, References } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { AppConfig } from "./config.js";
import { httpServerLayer } from "./http-server-layer.js";
import { AlphaEssCloudApiDataAdapterLayer } from "./data-adapter/alpha-ess-api.data-adapter.js";
import { TeslaClient, TeslaClientLayer } from "./tesla-client/index.js";
import { ElectricVehicle } from "./domain/electric-vehicle.js";
import { App, AppLayer, type TimingConfig } from "./app.js";
import type { ChargingConfig } from "./domain/charging-session.js";
import { BatteryStateManagerLayer } from "./battery-state-manager.js";
import { FixedSpeedControllerLayer } from "./charging-speed-controller/fixed-speed.controller.js";
import { ConservativeControllerLayer } from "./charging-speed-controller/conservative-controller.js";
import { ExcessFeedInSolarControllerLayer } from "./charging-speed-controller/excess-feed-in-solar-controller.js";
import { ExcessSolarAggresiveControllerLayer } from "./charging-speed-controller/excess-solar-aggresive-controller.js";
import { ExcessSolarNonAggresiveControllerLayer } from "./charging-speed-controller/excess-solar-non-aggresive.controller.js";
import { DynamicChargingConfigLayer } from "./charging-speed-controller/dynamic-config.js";
import { WeatherAwareBufferControllerLayer } from "./charging-speed-controller/weather-aware-buffer/index.js";
import { AppRuntimeLayer } from "./app-runtime.js";
import { ApiRoutes } from "./http-api.js";
import { SolcastForecastLayer } from "./solar-forecast/solcast.adapter.js";

const serviceLayers = Layer.mergeAll(AlphaEssCloudApiDataAdapterLayer);

const createTeslaClientLayer = (config: {
  readonly appDomain: string;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  readonly vin: string;
}) => {
  const base = TeslaClientLayer(config);
  const ev = Layer.effect(
    ElectricVehicle,
    Effect.map(TeslaClient, (client): ElectricVehicle["Service"] => client)
  );
  return Layer.mergeAll(base, ev.pipe(Layer.provide(base)));
};

const maxRuntimeHours = process.argv.includes("--max-runtime-hours")
  ? parseInt(process.argv[process.argv.indexOf("--max-runtime-hours") + 1])
  : undefined;

const chargingConfig: ChargingConfig = {
  waitPerAmereInSeconds: 2.2,
  extraWaitOnChargeStartInSeconds: 10,
  extraWaitOnChargeStopInSeconds: 10
};

const timingConfigBase = {
  syncIntervalInMs: 5000,
  vehicleAwakeningTimeInMs: 10 * 1000,
  inactivityTimeInSeconds: 15 * 60
};

const MainLayer = Layer.unwrap(
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

    const bufferPower = yield* AppConfig.excessSolar.bufferPower;

    let controllerLayer;

    if (process.argv.includes("--fixed-lowest-speed")) {
      const fixedSpeed = yield* AppConfig.controller.fixedSpeedAmpere;
      controllerLayer = FixedSpeedControllerLayer({ fixedSpeed, bufferPower: 300 }).pipe(
        Layer.provideMerge(DynamicChargingConfigLayer(bufferPower))
      );
    } else if (process.argv.includes("--conservative")) {
      controllerLayer = ConservativeControllerLayer().pipe(Layer.provideMerge(DynamicChargingConfigLayer(bufferPower)));
    } else if (process.argv.includes("--excess-feed-in-solar")) {
      const maxFeedInAllowed = yield* AppConfig.controller.maxAllowedFeedInPower;
      controllerLayer = ExcessFeedInSolarControllerLayer({ maxFeedInAllowed }).pipe(
        Layer.provideMerge(DynamicChargingConfigLayer(bufferPower))
      );
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
        ),
        Layer.provideMerge(DynamicChargingConfigLayer(bufferPower))
      );
    } else {
      controllerLayer = ExcessSolarNonAggresiveControllerLayer({
        baseControllerLayer: ExcessSolarAggresiveControllerLayer({
          multipleOf: 3
        })
      }).pipe(Layer.provideMerge(DynamicChargingConfigLayer(bufferPower)));
    }

    const teslaLayer = createTeslaClientLayer({
      appDomain: teslaAppDomain,
      clientId: teslaClientId,
      clientSecret: teslaClientSecret,
      vin: teslaVin
    });

    return AppLayer({
      chargingConfig,
      timingConfig,
      isDryRun: process.argv.includes("--dry-run"),
      costPerKwh
    }).pipe(
      Layer.provideMerge(controllerLayer),
      Layer.provideMerge(BatteryStateManagerLayer),
      Layer.provideMerge(AppRuntimeLayer),
      Layer.provideMerge(serviceLayers),
      Layer.provideMerge(teslaLayer),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(NodeHttpClient.layerFetch)
    );
  }).pipe(Effect.withSpan("MainLayer"))
);

const program = Effect.gen(function* () {
  const app = yield* App;

  const httpApiPort = yield* AppConfig.httpApi.port;
  yield* Effect.forkScoped(
    HttpRouter.serve(ApiRoutes).pipe(
      Layer.provide(httpServerLayer(httpApiPort)),
      Layer.build,
      Effect.flatMap(() => Effect.never)
    )
  );

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* app.stop();
      yield* Effect.logInfo("Finalizing, shutting down...");
    })
  );

  yield* app.start().pipe(
    Effect.catch((err) =>
      Effect.log(err).pipe(
        Effect.tap(() => Effect.logError("App crashed", err)),
        Effect.flatMap(() => app.stop())
      )
    )
  );
}).pipe(Effect.provide(MainLayer), Effect.scoped, Effect.withSpan("program"));

const runProgram = Effect.gen(function* () {
  const nodeEnv = yield* Config.string("NODE_ENV").pipe(Config.withDefault("production"));
  const logLevel = nodeEnv === "production" ? ("Info" as const) : ("Debug" as const);
  return yield* program.pipe(Effect.provideService(References.MinimumLogLevel, logLevel));
}).pipe(
  Effect.tapDefect((cause) => Effect.logError("Defect detected", cause)),
  Effect.withSpan("runProgram")
);

// 3. Execution
NodeRuntime.runMain(runProgram, { disableErrorReporting: true });
