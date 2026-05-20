import { Layer } from "effect";
import { HttpApi, HttpApiBuilder, OpenApi } from "effect/unstable/httpapi";
import { HealthGroup, HealthHandlers } from "./health.js";
import { StateGroup, StateHandlers } from "./state.js";
import { DynamicChargingConfigGroup, DynamicConfigHandlers } from "./dynamic-charging-config.js";
import { ValidationErrorHandlerLayer } from "./validation-error.js";

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

const HealthLayer = HttpApiBuilder.group(Api, "health", HealthHandlers);
const StateLayer = HttpApiBuilder.group(Api, "state", StateHandlers);
const DynamicConfigLayer = HttpApiBuilder.group(Api, "dynamicChargingConfig", DynamicConfigHandlers);

export const ApiRoutes = HttpApiBuilder.layer(Api, {
  openapiPath: "/openapi.json"
}).pipe(
  Layer.provide(HealthLayer),
  Layer.provide(StateLayer),
  Layer.provide(DynamicConfigLayer),
  Layer.provide(ValidationErrorHandlerLayer)
);
