import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { NodeHttpServer } from "@effect/platform-node";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { DynamicChargingConfig } from "../../../charging-speed-controller/dynamic-config.js";
import { DynamicChargingConfigGroup } from "../../../http/dynamic-charging-config.js";
import { ValidationErrorHandlerLayer } from "../../../http/validation-error.js";

describe("HTTP /dynamic-charging-config", () => {
  const makeTestLayer = Effect.gen(function* () {
    const bufferPowerRef = yield* Ref.make(1000);

    return Layer.mergeAll(
      Layer.succeed(DynamicChargingConfig, {
        getBufferPower: Ref.get(bufferPowerRef),
        setBufferPower: (n) => Ref.set(bufferPowerRef, n)
      })
    );
  });

  it.effect("GET /dynamic-charging-config returns bufferPower", () =>
    Effect.gen(function* () {
      class TestApi extends HttpApi.make("test").add(DynamicChargingConfigGroup) {}

      const groupLayer = HttpApiBuilder.group(
        TestApi,
        "dynamicChargingConfig",
        Effect.fnUntraced(function* (handlers) {
          const dynamicConfig = yield* DynamicChargingConfig;
          return handlers
            .handle("getConfig", () => Effect.map(dynamicConfig.getBufferPower, (bufferPower) => ({ bufferPower })))
            .handle("setConfig", ({ payload }) =>
              Effect.map(dynamicConfig.setBufferPower(payload.bufferPower), () => ({
                bufferPower: payload.bufferPower
              }))
            );
        })
      );

      const routes = HttpApiBuilder.layer(TestApi).pipe(
        Layer.provide(groupLayer),
        Layer.provide(ValidationErrorHandlerLayer),
        Layer.provide(yield* makeTestLayer)
      );

      yield* HttpRouter.serve(routes).pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("/dynamic-charging-config");
      const body = yield* response.json;
      expect(body).toEqual({ bufferPower: 1000 });
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  );

  it.effect("PATCH /dynamic-charging-config with invalid body returns 400 with descriptive message", () =>
    Effect.gen(function* () {
      class TestApi extends HttpApi.make("test").add(DynamicChargingConfigGroup) {}

      const groupLayer = HttpApiBuilder.group(
        TestApi,
        "dynamicChargingConfig",
        Effect.fnUntraced(function* (handlers) {
          const dynamicConfig = yield* DynamicChargingConfig;
          return handlers
            .handle("getConfig", () => Effect.map(dynamicConfig.getBufferPower, (bufferPower) => ({ bufferPower })))
            .handle("setConfig", ({ payload }) =>
              Effect.map(dynamicConfig.setBufferPower(payload.bufferPower), () => ({
                bufferPower: payload.bufferPower
              }))
            );
        })
      );

      const routes = HttpApiBuilder.layer(TestApi).pipe(
        Layer.provide(groupLayer),
        Layer.provide(ValidationErrorHandlerLayer),
        Layer.provide(yield* makeTestLayer)
      );

      yield* HttpRouter.serve(routes).pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.patch("/dynamic-charging-config", {
        body: HttpBody.raw(JSON.stringify({ bufferPower: "a100" }), {
          contentType: "application/json"
        })
      });
      expect(response.status).toBe(400);
      const body = yield* response.json;
      expect(body).toEqual({
        kind: "Payload",
        message: 'Expected a numeric value, got "a100"\n  at ["bufferPower"]'
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  );

  it.effect("POST /dynamic-charging-config returns 404 (no POST handler)", () =>
    Effect.gen(function* () {
      class TestApi extends HttpApi.make("test").add(DynamicChargingConfigGroup) {}

      const groupLayer = HttpApiBuilder.group(
        TestApi,
        "dynamicChargingConfig",
        Effect.fnUntraced(function* (handlers) {
          const dynamicConfig = yield* DynamicChargingConfig;
          return handlers
            .handle("getConfig", () => Effect.map(dynamicConfig.getBufferPower, (bufferPower) => ({ bufferPower })))
            .handle("setConfig", ({ payload }) =>
              Effect.map(dynamicConfig.setBufferPower(payload.bufferPower), () => ({
                bufferPower: payload.bufferPower
              }))
            );
        })
      );

      const routes = HttpApiBuilder.layer(TestApi).pipe(
        Layer.provide(groupLayer),
        Layer.provide(ValidationErrorHandlerLayer),
        Layer.provide(yield* makeTestLayer)
      );

      yield* HttpRouter.serve(routes).pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.post("/dynamic-charging-config");
      expect(response.status).toBe(404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  );

  it.effect("GET /nonexistent returns 404", () =>
    Effect.gen(function* () {
      class TestApi extends HttpApi.make("test").add(DynamicChargingConfigGroup) {}

      const groupLayer = HttpApiBuilder.group(
        TestApi,
        "dynamicChargingConfig",
        Effect.fnUntraced(function* (handlers) {
          const dynamicConfig = yield* DynamicChargingConfig;
          return handlers
            .handle("getConfig", () => Effect.map(dynamicConfig.getBufferPower, (bufferPower) => ({ bufferPower })))
            .handle("setConfig", ({ payload }) =>
              Effect.map(dynamicConfig.setBufferPower(payload.bufferPower), () => ({
                bufferPower: payload.bufferPower
              }))
            );
        })
      );

      const routes = HttpApiBuilder.layer(TestApi).pipe(
        Layer.provide(groupLayer),
        Layer.provide(ValidationErrorHandlerLayer),
        Layer.provide(yield* makeTestLayer)
      );

      yield* HttpRouter.serve(routes).pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("/nonexistent");
      expect(response.status).toBe(404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  );
});
