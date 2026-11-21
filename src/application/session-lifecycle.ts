import type { TeslaClientService } from "../tesla-client/index.js";
import type { IDataAdapter } from "../data-adapter/types.js";
import type { ChargingControlState, ChargingSessionStats } from "../domain/charging-session.js";
import { withDailyImportRecorded, withChargeEnergyRecorded, withSessionStarted } from "../domain/charging-session.js";
import { computeSessionSummary, type SessionSummary } from "../domain/session-summary.js";
import type { TeslaChargerEvent } from "../domain/events.js";
import { DateTime, Duration, Effect, FiberSet, PubSub, Ref } from "effect";
import { startEventLogger } from "../event-logger/index.js";
import type { TimingConfig } from "../app.js";
import { KiloWattHours as KWh, type TimeOfDay, StateOfCharge, Voltage } from "../domain/brands.js";

export const beginSession = Effect.fn("beginSession")(function* (
  teslaClient: TeslaClientService,
  dataAdapter: IDataAdapter,
  batteryStateManager: {
    readonly start: (pubSub: PubSub.PubSub<TeslaChargerEvent>) => Effect.Effect<void>;
  },
  statsRef: Ref.Ref<ChargingSessionStats>,
  pubSub: PubSub.PubSub<TeslaChargerEvent>,
  fibers: FiberSet.FiberSet<unknown, unknown>,
  options?: { readonly forceChargeToHundredPercent?: boolean }
) {
  yield* teslaClient.refreshAccessToken();
  yield* teslaClient.setupAccessTokenAutoRefreshRecurring(60 * 60 * 2).pipe(
    Effect.flatMap(() => Effect.void),
    Effect.forkScoped
  );

  yield* Effect.sleep(1000);

  const initialData = yield* dataAdapter.queryLatestValues(["daily_import"]);
  const startedStats = yield* withSessionStarted(yield* Ref.get(statsRef));
  yield* Ref.set(statsRef, withDailyImportRecorded(startedStats, KWh(initialData.daily_import)));

  const initialChargeState = yield* teslaClient.getChargeState().pipe(Effect.catch(() => Effect.succeed(null)));

  if (initialChargeState) {
    yield* Ref.update(statsRef, (s) => withChargeEnergyRecorded(s, initialChargeState.chargeEnergyAdded));

    if (options?.forceChargeToHundredPercent === true && initialChargeState.chargeLimitSoc < StateOfCharge(100)) {
      yield* Effect.logInfo("Raising vehicle charge limit to 100% (not restored on shutdown)", {
        previousLimit: initialChargeState.chargeLimitSoc
      });
      // Best effort: the session still works (and ends gracefully) if the
      // vehicle refuses the new limit.
      yield* teslaClient.setChargeLimit(StateOfCharge(100)).pipe(
        Effect.catch((err) =>
          Effect.logWarning("Could not raise the vehicle charge limit to 100%", {
            reason: err._tag === "VehicleCommandFailed" ? err.message : err._tag
          })
        )
      );
    }
  } else if (options?.forceChargeToHundredPercent === true) {
    yield* Effect.logInfo("Charge state unavailable at startup, skipping forced charge to 100%");
  }

  yield* FiberSet.run(fibers, batteryStateManager.start(pubSub));
  yield* FiberSet.run(fibers, startEventLogger(pubSub));
});

// `PubSub.shutdown` unsubscribes subscribers and drops messages they have not
// pulled yet, so wait until `PubSub.size` reports that every subscriber has
// taken the published events before the hub is closed.
const flushPublishedEvents = Effect.fn("flushPublishedEvents")(function* (pubSub: PubSub.PubSub<TeslaChargerEvent>) {
  while ((yield* PubSub.size(pubSub)) > 0) {
    yield* Effect.yieldNow;
  }
});

export const endSession = Effect.fn("endSession")(function* (params: {
  teslaClient: TeslaClientService;
  dataAdapter: IDataAdapter;
  controlRef: Ref.Ref<ChargingControlState>;
  statsRef: Ref.Ref<ChargingSessionStats>;
  pubSub: PubSub.PubSub<TeslaChargerEvent>;
  costPerKwh: number;
  timingConfig: TimingConfig;
  cycleInFlight: boolean;
}) {
  const { teslaClient, dataAdapter } = params;
  const controlState = yield* Ref.get(params.controlRef);
  const stats = yield* Ref.get(params.statsRef);

  yield* Effect.log("Stopping app and interrupting all fibers", {
    ampereFluctuations: stats.ampereFluctuations
  });

  // A cycle commits `controlRef` only when it finishes, so an interrupted or
  // failed cycle leaves the last committed state behind even though the
  // vehicle may already be charging.
  if (controlState.status !== "Idle" || params.cycleInFlight) {
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
    }).pipe(
      // Shutdown must always proceed: the session summary still needs to be
      // recorded and the session fibers interrupted, even if the vehicle
      // refuses or fails to stop charging.
      Effect.catch((err) =>
        Effect.logWarning("Could not stop vehicle charging, continuing shutdown", {
          reason: err._tag === "VehicleCommandFailed" ? err.message : err._tag
        })
      )
    );
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
    finalDailyImport: KWh(finalDataValues.daily_import),
    finalVoltage: Voltage(finalDataValues.voltage),
    costPerKwh: params.costPerKwh,
    now: yield* DateTime.now
  });

  yield* PubSub.publish(params.pubSub, { _tag: "SessionEnded", summary });
  yield* flushPublishedEvents(params.pubSub);
  yield* PubSub.shutdown(params.pubSub);
});

export const sleepUntilTimeOfDay = Effect.fn("sleepUntilTimeOfDay")(function* (
  time: TimeOfDay,
  options?: { readonly zone?: DateTime.TimeZone }
) {
  const zone = options?.zone ?? DateTime.zoneMakeLocal();
  const now = DateTime.setZone(yield* DateTime.now, zone);

  const todayAtTime = DateTime.setParts(now, {
    hour: Math.floor(time / 60),
    minute: time % 60,
    second: 0,
    millisecond: 0
  });

  const isStillAheadToday = DateTime.toEpochMillis(todayAtTime) >= DateTime.toEpochMillis(now);
  const scheduledShutdown = isStillAheadToday ? todayAtTime : DateTime.add(todayAtTime, { days: 1 });
  const delayMs = DateTime.toEpochMillis(scheduledShutdown) - DateTime.toEpochMillis(now);

  yield* Effect.logInfo("Scheduled automatic shutdown", {
    shutdownAt: DateTime.formatIsoZoned(scheduledShutdown),
    inMilliseconds: delayMs
  });

  yield* Effect.sleep(Duration.millis(delayMs));
});
