import { Duration, Effect, PubSub } from "effect";
import { ElectricVehicle } from "../domain/electric-vehicle.js";
import { TeslaChargerEventPubSub } from "../domain/events.js";
import { VehicleAsleepError, VehicleCommandFailedError } from "../domain/errors.js";
import { AbruptProductionDropError } from "../errors/abrupt-production-drop.error.js";
import type {
  ChargingConfig,
  ChargingControlState,
  ChargingSessionStats,
  ChargingControlEvent
} from "../domain/charging-session.js";
import {
  requestChargeStart,
  requestChargeStop,
  requestAmpereChange,
  completeChargeStart,
  completeAmpereChange,
  completeChargeStop,
  recordFluctuation as recordFluctuationStat
} from "../domain/charging-session.js";
import type { TeslaChargerEvent } from "../domain/events.js";
import { DataNotAvailableError, SourceNotAvailableError } from "../data-adapter/types.js";

const publishChargingEvent = (
  event: ChargingControlEvent,
  pubSub: PubSub.PubSub<TeslaChargerEvent>
): Effect.Effect<void> =>
  Effect.gen(function* () {
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

export const syncTargetAmpere = (
  targetAmpere: number,
  controlState: ChargingControlState,
  sessionStats: ChargingSessionStats,
  config: ChargingConfig,
  waitForRampUp: (
    waitSeconds: number
  ) => Effect.Effect<void, AbruptProductionDropError | DataNotAvailableError | SourceNotAvailableError>
): Effect.Effect<
  { state: ChargingControlState; stats: ChargingSessionStats },
  | AbruptProductionDropError
  | VehicleAsleepError
  | VehicleCommandFailedError
  | DataNotAvailableError
  | SourceNotAvailableError,
  ElectricVehicle | TeslaChargerEventPubSub
> =>
  Effect.gen(function* () {
    const vehicle = yield* ElectricVehicle;
    const pubSub = yield* TeslaChargerEventPubSub;

    const amp = Math.min(32, targetAmpere);

    switch (controlState.status) {
      case "Idle": {
        if (amp >= 3) {
          const startResult = requestChargeStart(controlState, amp, config);
          yield* vehicle.startCharging();
          yield* vehicle.setAmpere(amp);
          let currentStats = startResult.recordFluctuation ? recordFluctuationStat(sessionStats) : sessionStats;
          yield* publishChargingEvent(startResult.events[0], pubSub);
          yield* waitForRampUp(startResult.waitSeconds);
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
          const stopResult = requestChargeStop(controlState, config);
          yield* vehicle.stopCharging();
          yield* Effect.sleep(Duration.seconds(stopResult.waitSeconds));
          const completed = completeChargeStop(stopResult.state);
          yield* PubSub.publish(pubSub, { _tag: "ChargingStopped" as const });
          return { state: completed.state, stats: sessionStats };
        }
        const changeResult = requestAmpereChange(controlState, amp, config);
        if ("unchanged" in changeResult) {
          return { state: controlState, stats: sessionStats };
        }
        yield* vehicle.setAmpere(amp);
        let currentStats = changeResult.recordFluctuation ? recordFluctuationStat(sessionStats) : sessionStats;
        yield* publishChargingEvent(changeResult.events[0], pubSub);
        yield* waitForRampUp(changeResult.waitSeconds);
        const completed = completeAmpereChange(changeResult.state);
        if (completed.events.length > 0) {
          yield* publishChargingEvent(completed.events[0], pubSub);
        }
        return { state: completed.state, stats: currentStats };
      }
    }
  });
