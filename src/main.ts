import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option, Redacted } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { HttpRouter } from "effect/unstable/http";
import { AppConfig } from "./config.js";
import { Watt } from "./domain/brands.js";
import { httpServerLayer } from "./http-server-layer.js";
import { AlphaEssCloudApiDataAdapterLayer } from "./data-adapter/alpha-ess-api.data-adapter.js";
import { TeslaClientLayer } from "./tesla-client/index.js";
import { App, AppLayer, type TimingConfig } from "./app.js";
import type { ChargingConfig } from "./domain/charging-session.js";
import { BatteryStateManager } from "./battery-state-manager.js";
import { FixedSpeedControllerLayer } from "./charging-speed-controller/fixed-speed.controller.js";
import { ConservativeControllerLayer } from "./charging-speed-controller/conservative-controller.js";
import { ExcessFeedInSolarControllerLayer } from "./charging-speed-controller/excess-feed-in-solar-controller.js";
import { ExcessSolarAggresiveControllerLayer } from "./charging-speed-controller/excess-solar-aggresive-controller.js";
import { ExcessSolarNonAggresiveControllerLayer } from "./charging-speed-controller/excess-solar-non-aggresive.controller.js";
import { DynamicChargingConfigLayer } from "./charging-speed-controller/dynamic-config.js";
import { WeatherAwareBufferControllerLayer } from "./charging-speed-controller/weather-aware-buffer/index.js";
import { AppRuntime } from "./app-runtime.js";
import { ApiRoutes } from "./http/index.js";
import { SolcastForecastLayer } from "./solar-forecast/solcast.adapter.js";

const createTeslaClientLayer = (config: {
  readonly appDomain: string;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  readonly vin: string;
}) => {
  return TeslaClientLayer(config);
};

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

const programBody = Effect.gen(function* () {
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
});

const cli = Command.make(
  "tesla-charger",
  {
    controller: Flag.choice("controller", [
      "fixed-lowest-speed",
      "conservative",
      "excess-feed-in-solar",
      "weather-aware"
    ] as const).pipe(Flag.withAlias("c"), Flag.optional, Flag.withDescription("Charging controller strategy")),
    maxRuntimeHours: Flag.integer("max-runtime-hours").pipe(
      Flag.withAlias("t"),
      Flag.optional,
      Flag.withDescription("Maximum runtime in hours before auto-shutdown")
    )
  },
  (parsed) => {
    const MainLayer = Layer.unwrap(
      Effect.gen(function* () {
        const timingConfig: TimingConfig = {
          ...timingConfigBase,
          ...(Option.isSome(parsed.maxRuntimeHours) && { maxRuntimeHours: parsed.maxRuntimeHours.value })
        };

        const teslaAppDomain = yield* AppConfig.tesla.appDomain;
        const teslaClientId = yield* AppConfig.tesla.oauth2ClientId;
        const teslaClientSecret = yield* AppConfig.tesla.oauth2ClientSecret;
        const teslaVin = yield* AppConfig.tesla.vin;
        const costPerKwh = yield* AppConfig.cost.perKwh;

        const bufferPower = yield* AppConfig.excessSolar.bufferPower;

        const controllerTag = Option.getOrElse(parsed.controller, () => "default" as const);
        let controllerLayer;

        if (controllerTag === "fixed-lowest-speed") {
          const fixedSpeed = yield* AppConfig.controller.fixedSpeedAmpere;
          controllerLayer = FixedSpeedControllerLayer({ fixedSpeed, bufferPower: Watt(300) }).pipe(
            Layer.provideMerge(DynamicChargingConfigLayer(bufferPower))
          );
        } else if (controllerTag === "conservative") {
          controllerLayer = ConservativeControllerLayer().pipe(
            Layer.provideMerge(DynamicChargingConfigLayer(bufferPower))
          );
        } else if (controllerTag === "excess-feed-in-solar") {
          const maxFeedInAllowed = yield* AppConfig.controller.maxAllowedFeedInPower;
          controllerLayer = ExcessFeedInSolarControllerLayer({ maxFeedInAllowed }).pipe(
            Layer.provideMerge(DynamicChargingConfigLayer(bufferPower))
          );
        } else if (controllerTag === "weather-aware") {
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
              multipleOf: 1
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
          costPerKwh
        }).pipe(
          Layer.provideMerge(controllerLayer),
          Layer.provideMerge(BatteryStateManager.layer),
          Layer.provideMerge(AppRuntime.layer),
          Layer.provideMerge(AlphaEssCloudApiDataAdapterLayer),
          Layer.provideMerge(teslaLayer)
        );
      })
    );

    return programBody.pipe(
      Effect.provide(MainLayer),
      Effect.scoped,
      Effect.withSpan("program"),
      Effect.tapDefect((cause) => Effect.logError("Defect detected", cause))
    );
  }
).pipe(Command.withDescription("Smart EV charging controller for Tesla vehicles"));

// 3. Execution
NodeRuntime.runMain(
  Command.run(cli, { version: "1.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerFetch))
  ),
  { disableErrorReporting: true }
);
