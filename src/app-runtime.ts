import { Context, Effect, Layer, Ref } from "effect";
import type { ChargingControlState, ChargingSessionStats } from "./domain/charging-session.js";
import {
  createInitialChargingControlState,
  createInitialChargingSessionStats,
  AppStatus
} from "./domain/charging-session.js";

export class AppRuntime extends Context.Service<
  AppRuntime,
  {
    readonly controlRef: Ref.Ref<ChargingControlState>;
    readonly statsRef: Ref.Ref<ChargingSessionStats>;
    readonly appStatusRef: Ref.Ref<AppStatus>;
  }
>()("@tesla-charger/AppRuntime") {}

export const AppRuntimeLayer = Layer.effect(
  AppRuntime,
  Effect.gen(function* () {
    const controlRef = yield* Ref.make(createInitialChargingControlState());
    const statsRef = yield* Ref.make(createInitialChargingSessionStats());
    const appStatusRef = yield* Ref.make(AppStatus.Pending);
    return { controlRef, statsRef, appStatusRef };
  })
);
