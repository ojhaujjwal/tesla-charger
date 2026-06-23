import { Effect, Ref, Schema } from "effect";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { AppRuntime } from "../app-runtime.js";
import { BatteryStateManager } from "../battery-state-manager.js";
import { AppStatus } from "../app-runtime.js";

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

export class StateGroup extends HttpApiGroup.make("state", { topLevel: true })
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

export const StateHandlers = Effect.fn("StateHandlers")(function* (
  handlers: HttpApiBuilder.Handlers.FromGroup<typeof StateGroup>
) {
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
});
