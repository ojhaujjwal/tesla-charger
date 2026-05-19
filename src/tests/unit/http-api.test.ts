import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { NodeHttpServer } from "@effect/platform-node";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";
import { AppRuntime } from "../../app-runtime.js";
import { BatteryStateManager, type BatteryState } from "../../battery-state-manager.js";
import { DynamicChargingConfig } from "../../charging-speed-controller/dynamic-config.js";
import { AppStatus, type ChargingControlState, type ChargingSessionStats } from "../../domain/charging-session.js";
import { ApiRoutes } from "../../http-api.js";

const makeTestLayer = Effect.gen(function* () {
  const controlRef = yield* Ref.make<ChargingControlState>({ status: "Idle" });
  const statsRef = yield* Ref.make<ChargingSessionStats>({
    ampereFluctuations: 5,
    sessionStartedAt: new Date("2026-05-17T10:00:00Z"),
    chargeEnergyAddedAtStartKwh: 1.5,
    dailyImportValueAtStart: 0.5
  });
  const appStatusRef = yield* Ref.make(AppStatus.Running);
  const bufferPowerRef = yield* Ref.make(1000);

  const batteryState: BatteryState = {
    batteryLevel: 72,
    chargeLimitSoc: 80,
    queriedAtMs: 1715600000000
  };

  return Layer.mergeAll(
    Layer.succeed(AppRuntime, { controlRef, statsRef, appStatusRef }),
    Layer.succeed(BatteryStateManager, {
      start: () => Effect.never,
      get: () => batteryState
    }),
    Layer.succeed(DynamicChargingConfig, {
      getBufferPower: Ref.get(bufferPowerRef),
      setBufferPower: (n) => Ref.set(bufferPowerRef, n)
    })
  );
});

const buildServer = () =>
  Effect.flatMap(makeTestLayer, (testLayer) => HttpRouter.serve(ApiRoutes).pipe(Layer.provide(testLayer), Layer.build));

describe("HTTP API", () => {
  it.effect("GET /healthz returns ok", () =>
    Effect.gen(function* () {
      yield* buildServer();
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("/healthz");
      expect(response.status).toBe(200);
      const text = yield* response.text;
      expect(text).toBe('"ok"');
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  );

  it.effect("GET /state returns live control, stats, appStatus and battery", () =>
    Effect.gen(function* () {
      yield* buildServer();
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("/state");
      const body = yield* response.json;
      expect(body).toMatchObject({
        control: { status: "Idle" },
        stats: {
          ampereFluctuations: 5,
          sessionStartedAt: "2026-05-17T10:00:00.000Z",
          chargeEnergyAddedAtStartKwh: 1.5,
          dailyImportValueAtStart: 0.5
        },
        appStatus: "Running",
        battery: {
          batteryLevel: 72,
          chargeLimitSoc: 80,
          queriedAtMs: 1715600000000
        }
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  );

  it.effect("GET /dynamic-charging-config returns bufferPower", () =>
    Effect.gen(function* () {
      yield* buildServer();
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("/dynamic-charging-config");
      const body = yield* response.json;
      expect(body).toEqual({ bufferPower: 1000 });
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  );

  it.effect("PATCH /dynamic-charging-config with invalid body returns 400 with error details", () =>
    Effect.gen(function* () {
      yield* buildServer();
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.patch("/dynamic-charging-config", {
        body: HttpBody.raw(JSON.stringify({ bufferPower: "a100" }), {
          contentType: "application/json"
        })
      });
      expect(response.status).toBe(400);
      const body = yield* response.json;
      expect(body).toHaveProperty("kind", "Payload");
      expect(body).toHaveProperty("message");
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  );

  it.effect("POST /dynamic-charging-config returns 404 (no POST handler)", () =>
    Effect.gen(function* () {
      yield* buildServer();
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.post("/dynamic-charging-config");
      expect(response.status).toBe(404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  );

  it.effect("GET /nonexistent returns 404", () =>
    Effect.gen(function* () {
      yield* buildServer();
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("/nonexistent");
      expect(response.status).toBe(404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  );

  it.effect("GET /openapi.json returns OpenAPI spec", () =>
    Effect.gen(function* () {
      yield* buildServer();
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("/openapi.json");
      const body = yield* response.json;
      expect(body).toHaveProperty("openapi");
      expect(body).toHaveProperty("info.title", "Tesla Charger API");
      expect(body).toHaveProperty("paths./healthz");
      expect(body).toHaveProperty("paths./state");
      expect(body).toHaveProperty("paths./dynamic-charging-config");
      expect(body).toHaveProperty("paths./dynamic-charging-config.patch.responses.400");
      expect(body).toHaveProperty("paths./dynamic-charging-config.patch.responses.200");
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  );
});
