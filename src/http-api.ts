import { Effect, Layer, Ref, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  OpenApi
} from "effect/unstable/httpapi";
import { AppRuntime } from "./app-runtime.js";
import { DynamicChargingConfig } from "./charging-speed-controller/dynamic-config.js";
import { BatteryStateManager } from "./battery-state-manager.js";
import { AppStatus } from "./domain/charging-session.js";

const ChargingControlStateSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("Idle") }),
  Schema.Struct({ status: Schema.Literal("Starting"), targetAmpere: Schema.Number }),
  Schema.Struct({ status: Schema.Literal("Charging"), ampere: Schema.Number }),
  Schema.Struct({ status: Schema.Literal("ChangingAmpere"), current: Schema.Number, target: Schema.Number }),
  Schema.Struct({ status: Schema.Literal("Stopping") })
]);

const ChargingSessionStatsSchema = Schema.Struct({
  ampereFluctuations: Schema.Number,
  sessionStartedAt: Schema.NullOr(Schema.Date),
  chargeEnergyAddedAtStartKwh: Schema.Number,
  dailyImportValueAtStart: Schema.Number
});

const BatteryStateSchema = Schema.Struct({
  batteryLevel: Schema.Number,
  chargeLimitSoc: Schema.Number,
  queriedAtMs: Schema.Number
});

const StateResponseSchema = Schema.Struct({
  control: ChargingControlStateSchema,
  stats: ChargingSessionStatsSchema,
  appStatus: Schema.String,
  battery: Schema.NullOr(BatteryStateSchema)
});

const DynamicConfigSchema = Schema.Struct({
  bufferPower: Schema.Finite.pipe(
    Schema.annotate({ message: "Expected a numeric value", identifier: "a numeric value" })
  )
});

class HealthGroup extends HttpApiGroup.make("health", { topLevel: true })
  .add(
    HttpApiEndpoint.get("healthz", "/healthz", {
      success: Schema.String
    })
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Health",
      description: "Liveness check endpoint"
    })
  ) {}

class StateGroup extends HttpApiGroup.make("state", { topLevel: true })
  .add(
    HttpApiEndpoint.get("state", "/state", {
      success: StateResponseSchema
    })
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "State",
      description: "Full application state snapshot"
    })
  ) {}

const ValidationErrorBody = Schema.Struct({
  kind: Schema.String,
  message: Schema.String
}).pipe(Schema.annotate({ httpApiStatus: 400 }));

class ValidationErrorHandler extends HttpApiMiddleware.Service<ValidationErrorHandler>()(
  "tesla-charger/ValidationErrorHandler",
  { error: ValidationErrorBody }
) {}

const ValidationErrorHandlerLayer = HttpApiMiddleware.layerSchemaErrorTransform(ValidationErrorHandler, (schemaError) =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      {
        kind: schemaError.kind,
        message: schemaError.cause.message
      },
      { status: 400 }
    )
  )
);

class DynamicChargingConfigGroup extends HttpApiGroup.make("dynamicChargingConfig", { topLevel: true })
  .add(
    HttpApiEndpoint.get("getConfig", "/dynamic-charging-config", {
      success: DynamicConfigSchema
    }),
    HttpApiEndpoint.patch("setConfig", "/dynamic-charging-config", {
      payload: DynamicConfigSchema,
      success: DynamicConfigSchema
    })
  )
  .middleware(ValidationErrorHandler)
  .annotateMerge(
    OpenApi.annotations({
      title: "Dynamic Charging Config",
      description: "Runtime configuration for the charging controller"
    })
  ) {}

class Api extends HttpApi.make("tesla-charger")
  .add(HealthGroup)
  .add(StateGroup)
  .add(DynamicChargingConfigGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "Tesla Charger API",
      description: "REST API for monitoring and controlling the Tesla charger"
    })
  ) {}

const HealthHandlers = HttpApiBuilder.group(
  Api,
  "health",
  Effect.fnUntraced(function* (handlers) {
    yield* Effect.void;
    return handlers.handle("healthz", () => Effect.succeed("ok"));
  })
);

const StateHandlers = HttpApiBuilder.group(
  Api,
  "state",
  Effect.fnUntraced(function* (handlers) {
    const appRuntime = yield* AppRuntime;
    const batteryStateManager = yield* BatteryStateManager;
    return handlers.handle("state", () =>
      Effect.gen(function* () {
        const control = yield* Ref.get(appRuntime.controlRef);
        const stats = yield* Ref.get(appRuntime.statsRef);
        const appStatus = yield* Ref.get(appRuntime.appStatusRef);
        const battery = batteryStateManager.get();
        return {
          control,
          stats,
          appStatus: AppStatus[appStatus],
          battery
        };
      })
    );
  })
);

const DynamicConfigHandlers = HttpApiBuilder.group(
  Api,
  "dynamicChargingConfig",
  Effect.fnUntraced(function* (handlers) {
    const dynamicConfig = yield* DynamicChargingConfig;
    return handlers
      .handle("getConfig", () => Effect.map(dynamicConfig.getBufferPower, (bufferPower) => ({ bufferPower })))
      .handle("setConfig", ({ payload }) =>
        Effect.map(dynamicConfig.setBufferPower(payload.bufferPower), () => ({ bufferPower: payload.bufferPower }))
      );
  })
);

export const ApiRoutes = HttpApiBuilder.layer(Api, {
  openapiPath: "/openapi.json"
}).pipe(
  Layer.provide(HealthHandlers),
  Layer.provide(StateHandlers),
  Layer.provide(DynamicConfigHandlers),
  Layer.provide(ValidationErrorHandlerLayer)
);
