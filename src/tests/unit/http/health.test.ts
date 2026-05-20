import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { NodeHttpServer } from "@effect/platform-node";
import { HttpClient, HttpRouter } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { HealthGroup } from "../../../http/health.js";

describe("HTTP /healthz", () => {
  it.effect("GET /healthz returns ok", () =>
    Effect.gen(function* () {
      class TestApi extends HttpApi.make("test").add(HealthGroup) {}

      const routes = HttpApiBuilder.layer(TestApi).pipe(
        Layer.provide(
          HttpApiBuilder.group(
            TestApi,
            "health",
            Effect.fnUntraced(function* (handlers) {
              yield* Effect.void;
              return handlers.handle("healthz", () => Effect.succeed("ok"));
            })
          )
        )
      );

      yield* HttpRouter.serve(routes).pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("/healthz");
      expect(response.status).toBe(200);
      const text = yield* response.text;
      expect(text).toBe('"ok"');
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  );
});
