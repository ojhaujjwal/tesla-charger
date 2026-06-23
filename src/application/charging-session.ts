import { Duration, Effect, Layer, PubSub, Schedule } from "effect";
import { DataAdapter } from "../data-adapter/types.js";
import { ChargingSpeedController } from "../charging-speed-controller/types.js";
import { ElectricVehicle } from "../domain/electric-vehicle.js";
import { BatteryStateManager } from "../battery-state-manager.js";
import { TeslaChargerEventPubSub } from "../domain/events.js";
import { AbruptProductionDropError } from "../errors/abrupt-production-drop.error.js";
import { VehicleNotWakingUpError } from "../errors/vehicle-not-waking-up.error.js";
import { GridImportExhaustedError } from "../errors/grid-import-exhausted.error.js";
import { Ampere, Voltage } from "../domain/brands.js";
import {
  ChargingSession,
  requestChargeStart,
  requestChargeStop,
  requestAmpereChange,
  completeChargeStart,
  completeAmpereChange,
  completeChargeStop,
  recordFluctuation,
  type ChargingConfig,
  type ChargingControlState,
  type ChargingSessionStats,
  type ChargingControlEvent,
  type SessionOutcome
} from "../domain/charging-session.js";

export const ChargingSessionLive = (config: {
  readonly chargingConfig: ChargingConfig;
  readonly watchCadenceInSeconds: number;
  readonly syncIntervalInMs: number;
  readonly vehicleAwakeningTimeInMs: number;
  readonly asleepRetryCount: number;
  readonly abruptRetryCount: number;
}) =>
  Layer.effect(
    ChargingSession,
    Effect.gen(function* () {
      const dataAdapter = yield* DataAdapter;
      const chargingSpeedController = yield* ChargingSpeedController;
      const vehicle = yield* ElectricVehicle;
      const batteryStateManager = yield* BatteryStateManager;
      const pubSub = yield* TeslaChargerEventPubSub;

      const publishChargingEvent = Effect.fn("publishChargingEvent")(function* (event: ChargingControlEvent) {
        switch (event.type) {
          case "ChargingStarted":
            return yield* PubSub.publish(pubSub, { _tag: "ChargingStarted" as const });
          case "ChargingStopped":
            return yield* PubSub.publish(pubSub, { _tag: "ChargingStopped" as const });
          case "AmpereChangeInitiated":
            return yield* PubSub.publish(pubSub, {
              _tag: "AmpereChangeInitiated" as const,
              previous: event.previous,
              current: event.current
            });
          case "AmpereChangeFinished":
            return yield* PubSub.publish(pubSub, {
              _tag: "AmpereChangeFinished" as const,
              current: event.current
            });
        }
      });

      const rampUpWatch = Effect.fn("rampUpWatch")(function* (waitSeconds: number, initialProduction: number) {
        return yield* Effect.race(
          Effect.void.pipe(Effect.delay(Duration.seconds(waitSeconds))),
          Effect.repeat(
            Effect.gen(function* () {
              const { current_production: currentProduction, import_from_grid: importingFromGrid } =
                yield* dataAdapter.queryLatestValues(["current_production", "import_from_grid"]);
              if (importingFromGrid > 0) {
                return yield* new AbruptProductionDropError({
                  initialProduction,
                  currentProduction
                });
              }
            }),
            Schedule.fixed(Duration.seconds(config.watchCadenceInSeconds))
          )
        );
      });

      const executeSyncBody = Effect.fn("executeSyncBody")(function* (
        targetAmpere: Ampere,
        controlState: ChargingControlState,
        sessionStats: ChargingSessionStats,
        initialProduction: number
      ) {
        const amp = targetAmpere;

        switch (controlState.status) {
          case "Idle": {
            if (amp >= 3) {
              const startResult = requestChargeStart(controlState, amp, config.chargingConfig);
              yield* vehicle.startCharging();
              yield* vehicle.setAmpere(amp);
              const currentStats = recordFluctuation(sessionStats);
              yield* publishChargingEvent(startResult.events[0]);
              yield* rampUpWatch(startResult.waitSeconds, initialProduction);
              const completed = completeChargeStart(startResult.state);
              return { state: completed.state, stats: currentStats };
            }
            return { state: controlState, stats: sessionStats };
          }
          case "Starting":
          case "ChangingAmpere":
          case "Stopping": {
            return { state: controlState, stats: sessionStats };
          }
          case "Charging": {
            if (amp < 3) {
              const stopResult = requestChargeStop(controlState, config.chargingConfig);
              yield* vehicle.stopCharging();
              yield* Effect.sleep(Duration.seconds(stopResult.waitSeconds));
              const completed = completeChargeStop(stopResult.state);
              yield* PubSub.publish(pubSub, { _tag: "ChargingStopped" as const });
              return { state: completed.state, stats: sessionStats };
            }
            const changeResult = requestAmpereChange(controlState, amp, config.chargingConfig);
            if ("unchanged" in changeResult) {
              return { state: controlState, stats: sessionStats };
            }
            yield* vehicle.setAmpere(amp);
            const currentStats = recordFluctuation(sessionStats);
            yield* publishChargingEvent(changeResult.events[0]);
            yield* rampUpWatch(changeResult.waitSeconds, initialProduction);
            const completed = completeAmpereChange(changeResult.state);
            if (completed.events.length > 0) {
              yield* publishChargingEvent(completed.events[0]);
            }
            return { state: completed.state, stats: currentStats };
          }
        }
      });

      const runCycle = Effect.fn("runCycle")(function* (
        controlState: ChargingControlState,
        sessionStats: ChargingSessionStats
      ) {
        const currentSpeed = controlState.status === "Charging" ? controlState.ampere : Ampere(0);
        const targetAmpere = yield* chargingSpeedController.determineChargingSpeed(currentSpeed);

        const { current_production: currentProductionAtStart } = yield* dataAdapter.queryLatestValues([
          "current_production"
        ]);

        const syncResult = yield* executeSyncBody(
          targetAmpere,
          controlState,
          sessionStats,
          currentProductionAtStart
        ).pipe(
          Effect.retry({
            times: config.asleepRetryCount,
            while: (err) => {
              if (err._tag !== "VehicleAsleepError") return false;
              return Effect.sleep(Duration.millis(config.vehicleAwakeningTimeInMs)).pipe(
                Effect.flatMap(() => vehicle.wakeUpCar().pipe(Effect.map(() => true))),
                Effect.catch(() => Effect.succeed(false))
              );
            }
          }),
          Effect.catchTag("VehicleAsleepError", () =>
            Effect.fail(new VehicleNotWakingUpError({ wakeupAttempts: config.asleepRetryCount }))
          ),
          Effect.retry({
            times: config.abruptRetryCount,
            while: (err) => {
              if (err._tag !== "AbruptProductionDrop") return false;
              return Effect.succeed(true);
            }
          }),
          Effect.catchTag("AbruptProductionDrop", (err) =>
            Effect.fail(
              new GridImportExhaustedError({
                initialProduction: err.initialProduction,
                currentProduction: err.currentProduction
              })
            )
          )
        );

        yield* Effect.sleep(config.syncIntervalInMs);

        const { current_load: currentLoad, voltage: rawVoltage } = yield* dataAdapter.queryLatestValues([
          "current_load",
          "voltage"
        ]);
        const voltage = Voltage(rawVoltage);
        const currentLoadAmpere = currentLoad / voltage;

        if (syncResult.state.status === "Charging") {
          const expectedAmpere = syncResult.state.ampere;
          if (expectedAmpere > 0 && currentLoadAmpere < expectedAmpere) {
            yield* Effect.logDebug("load power not expected", {
              currentLoad,
              voltage,
              expectedAmpere
            });
          }
        }

        const batteryState = batteryStateManager.get();
        const outcome: SessionOutcome =
          batteryState && batteryState.batteryLevel >= batteryState.chargeLimitSoc
            ? { status: "Completed" }
            : { status: "Running" };

        return { state: syncResult.state, stats: syncResult.stats, outcome };
      });

      return ChargingSession.of({ runCycle });
    }).pipe(Effect.withSpan("ChargingSessionLive"))
  );
