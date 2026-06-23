import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { NodeHttpServer } from "@effect/platform-node";
import { HttpClient, HttpRouter } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { AppRuntime } from "../../../app-runtime.js";
import { BatteryStateManager, type BatteryState } from "../../../battery-state-manager.js";
import { AppStatus } from "../../../app-runtime.js";
import { _Idle, type ChargingControlState, type ChargingSessionStats } from "../../../domain/charging-session.js";
import { StateGroup } from "../../../http/state.js";
import { KiloWattHours as KWh, StateOfCharge } from "../../../domain/brands.js";

describe("HTTP /state", () => {
  it.effect("GET /state returns live control, stats, appStatus and battery", () =>
    Effect.gen(function* () {
      const controlRef = yield* Ref.make<ChargingControlState>(_Idle({ status: "Idle" }));
      const statsRef = yield* Ref.make<ChargingSessionStats>({
        ampereFluctuations: 5,
        sessionStartedAt: new Date("2026-05-17T10:00:00Z"),
        chargeEnergyAddedAtStartKwh: KWh(1.5),
        dailyImportValueAtStart: KWh(0.5)
      });
      const appStatusRef = yield* Ref.make(AppStatus.Running);

      const batteryState: BatteryState = {
        batteryLevel: StateOfCharge(72),
        chargeLimitSoc: StateOfCharge(80),
        queriedAtMs: 1715600000000
      };

      class TestApi extends HttpApi.make("test").add(StateGroup) {}

      const routes = HttpApiBuilder.layer(TestApi).pipe(
        Layer.provide(
          HttpApiBuilder.group(
            TestApi,
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
          )
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(AppRuntime, { controlRef, statsRef, appStatusRef }),
            Layer.succeed(BatteryStateManager, {
              start: () => Effect.never,
              get: () => batteryState
            })
          )
        )
      );

      yield* HttpRouter.serve(routes).pipe(Layer.build);
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
});
