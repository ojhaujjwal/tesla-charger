import { Effect, Schema } from "effect";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { DynamicChargingConfig } from "../charging-speed-controller/dynamic-config.js";
import { Watt } from "../domain/brands.js";
import { ValidationErrorHandler } from "./validation-error.js";

const DynamicConfigSchema = Schema.Struct({
  bufferPower: Schema.Finite.pipe(
    Schema.annotate({ message: "Expected a numeric value", identifier: "a numeric value" })
  )
});

export class DynamicChargingConfigGroup extends HttpApiGroup.make("dynamicChargingConfig", { topLevel: true })
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

export const DynamicConfigHandlers = Effect.fnUntraced(function* (
  handlers: HttpApiBuilder.Handlers.FromGroup<typeof DynamicChargingConfigGroup>
) {
  const dynamicConfig = yield* DynamicChargingConfig;
  return handlers
    .handle("getConfig", () => Effect.map(dynamicConfig.getBufferPower, (bufferPower) => ({ bufferPower })))
    .handle("setConfig", ({ payload }) =>
      Effect.map(dynamicConfig.setBufferPower(Watt(payload.bufferPower)), () => ({
        bufferPower: payload.bufferPower
      }))
    );
});
