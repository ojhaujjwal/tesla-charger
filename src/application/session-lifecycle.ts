import type { TeslaClientService } from "../tesla-client/index.js";
import type {
  AuthenticationFailedError,
  VehicleAsleepError,
  VehicleCommandFailedError
} from "../tesla-client/errors.js";
import { DataNotAvailableError, SourceNotAvailableError, type IDataAdapter } from "../data-adapter/types.js";
import type { ChargingControlState, ChargingSessionStats } from "../domain/charging-session.js";
import { withDailyImportRecorded, withChargeEnergyRecorded, withSessionStarted } from "../domain/charging-session.js";
import { computeSessionSummary, type SessionSummary } from "../domain/session-summary.js";
import type { TeslaChargerEvent } from "../domain/events.js";
import { Duration, Effect, Fiber, PubSub, Ref } from "effect";
import { startEventLogger } from "../event-logger/index.js";
import type { TimingConfig } from "../app.js";

export const beginSession = (
  teslaClient: TeslaClientService,
  dataAdapter: IDataAdapter,
  batteryStateManager: {
    readonly start: (pubSub: PubSub.PubSub<TeslaChargerEvent>) => Effect.Effect<void>;
  },
  statsRef: Ref.Ref<ChargingSessionStats>,
  pubSub: PubSub.PubSub<TeslaChargerEvent>
): Effect.Effect<
  {
    tokenRefreshFiber: Fiber.Fiber<void, AuthenticationFailedError>;
    batteryStateManagerFiber: Fiber.Fiber<void, never>;
    eventLoggerFiber: Fiber.Fiber<void, never>;
  },
  AuthenticationFailedError | DataNotAvailableError | SourceNotAvailableError
> =>
  Effect.gen(function* () {
    yield* teslaClient.refreshAccessToken();
    const tokenRefreshFiber = yield* teslaClient.setupAccessTokenAutoRefreshRecurring(60 * 60 * 2).pipe(
      Effect.flatMap(() => Effect.void),
      Effect.forkChild
    );

    yield* Effect.sleep(1000);

    const initialData = yield* dataAdapter.queryLatestValues(["daily_import"]);
    yield* Ref.update(statsRef, (s) => withDailyImportRecorded(withSessionStarted(s), initialData.daily_import));

    const initialChargeState = yield* teslaClient.getChargeState().pipe(Effect.catch(() => Effect.succeed(null)));

    if (initialChargeState) {
      yield* Ref.update(statsRef, (s) => withChargeEnergyRecorded(s, initialChargeState.chargeEnergyAdded));
    }

    const batteryStateManagerFiber = yield* batteryStateManager.start(pubSub).pipe(Effect.forkChild);
    const eventLoggerFiber = yield* startEventLogger(pubSub).pipe(Effect.forkChild);

    return { tokenRefreshFiber, batteryStateManagerFiber, eventLoggerFiber };
  });

export const endSession = (params: {
  teslaClient: TeslaClientService;
  dataAdapter: IDataAdapter;
  controlRef: Ref.Ref<ChargingControlState>;
  statsRef: Ref.Ref<ChargingSessionStats>;
  pubSub: PubSub.PubSub<TeslaChargerEvent>;
  costPerKwh: number;
  timingConfig: TimingConfig;
  fibers: ReadonlyArray<Fiber.Fiber<unknown, unknown>>;
}): Effect.Effect<void, VehicleAsleepError | VehicleCommandFailedError> =>
  Effect.gen(function* () {
    const { teslaClient, dataAdapter } = params;
    const controlState = yield* Ref.get(params.controlRef);
    const stats = yield* Ref.get(params.statsRef);

    yield* Effect.log("Stopping app and interrupting all fibers", {
      ampereFluctuations: stats.ampereFluctuations
    });

    if (controlState.status !== "Idle") {
      yield* Effect.retry(teslaClient.stopCharging(), {
        times: 3,
        while: (err) => {
          if (err._tag === "VehicleAsleepError") {
            return Effect.sleep(Duration.millis(params.timingConfig.vehicleAwakeningTimeInMs)).pipe(
              Effect.flatMap(() => teslaClient.wakeUpCar().pipe(Effect.map(() => true))),
              Effect.catch((err) => Effect.log(err).pipe(Effect.map(() => false)))
            );
          }
          return true;
        }
      });
    }

    const finalChargeState = yield* teslaClient
      .getChargeState()
      .pipe(Effect.catch(() => Effect.succeed({ chargeEnergyAdded: stats.chargeEnergyAddedAtStartKwh })));

    const finalDataValues = yield* dataAdapter
      .queryLatestValues(["daily_import", "voltage"])
      .pipe(Effect.catch(() => Effect.succeed({ daily_import: stats.dailyImportValueAtStart, voltage: 230 })));

    const summary: SessionSummary = computeSessionSummary({
      stats,
      finalChargeEnergyAdded: finalChargeState.chargeEnergyAdded,
      finalDailyImport: finalDataValues.daily_import,
      finalVoltage: finalDataValues.voltage,
      costPerKwh: params.costPerKwh
    });

    yield* PubSub.publish(params.pubSub, { _tag: "SessionEnded", summary });
    yield* Effect.yieldNow;
    yield* PubSub.shutdown(params.pubSub);

    for (const fiber of params.fibers) {
      yield* Fiber.interrupt(fiber);
    }
  });

export const shutdownAfterMaxRuntime = (maxHours: number, stop: Effect.Effect<void>): Effect.Effect<void> =>
  Effect.sleep(Duration.hours(maxHours)).pipe(Effect.flatMap(() => stop));
