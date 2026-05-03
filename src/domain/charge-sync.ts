import { Duration, Effect, PubSub } from "effect";
import type { ElectricVehicle } from "./electric-vehicle.js";
import { VehicleAsleepError, VehicleCommandFailedError } from "./errors.js";
import type {
  ChargingConfig,
  ChargingControlState,
  ChargingSessionStats,
  ChargingControlEvent
} from "./charging-session.js";
import {
  requestChargeStart,
  requestChargeStop,
  requestAmpereChange,
  completeChargeStart,
  completeAmpereChange,
  completeChargeStop,
  recordFluctuation as recordFluctuationStat
} from "./charging-session.js";
import type { TeslaChargerEvent } from "./events.js";

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

export const syncTargetAmpere = <E>(
  targetAmpere: number,
  controlState: ChargingControlState,
  sessionStats: ChargingSessionStats,
  config: ChargingConfig,
  isDryRun: boolean,
  vehicle: ElectricVehicle["Type"],
  pubSub: PubSub.PubSub<TeslaChargerEvent>,
  waitForRampUp: (waitSeconds: number) => Effect.Effect<void, E>
): Effect.Effect<
  { state: ChargingControlState; stats: ChargingSessionStats },
  E | VehicleAsleepError | VehicleCommandFailedError
> =>
  Effect.gen(function* () {
    const amp = Math.min(32, targetAmpere);

    // Only try stop when target is below charging threshold
    if (amp < 3) {
      const stopResult = requestChargeStop(controlState, config);
      if (stopResult.state.status !== controlState.status) {
        yield* isDryRun ? Effect.log("Stopping charging (dry run)") : vehicle.stopCharging();
        yield* Effect.sleep(Duration.seconds(stopResult.waitSeconds));
        let currentState = stopResult.state;
        const completed = completeChargeStop(currentState);
        currentState = completed.state;
        yield* PubSub.publish(pubSub, { _tag: "ChargingStopped" as const });
        return { state: currentState, stats: sessionStats };
      }
      return { state: controlState, stats: sessionStats };
    }

    // Try start
    const startResult = requestChargeStart(controlState, amp, config);
    if (startResult.events.length > 0) {
      yield* isDryRun ? Effect.log("Starting charging (dry run)") : vehicle.startCharging();
      yield* isDryRun ? Effect.log(`Setting ampere to ${amp} (dry run)`) : vehicle.setAmpere(amp);
      let currentState = startResult.state;
      let currentStats = sessionStats;
      if (startResult.recordFluctuation) {
        currentStats = recordFluctuationStat(currentStats);
      }
      yield* publishChargingEvent(startResult.events[0], pubSub);
      yield* waitForRampUp(startResult.waitSeconds);
      const completed = completeChargeStart(currentState);
      currentState = completed.state;
      return { state: currentState, stats: currentStats };
    }

    // Try ampere change
    const changeResult = requestAmpereChange(controlState, amp, config);
    if (changeResult.events.length > 0) {
      yield* isDryRun ? Effect.log(`Setting ampere to ${amp} (dry run)`) : vehicle.setAmpere(amp);
      let currentState = changeResult.state;
      let currentStats = sessionStats;
      if (changeResult.recordFluctuation) {
        currentStats = recordFluctuationStat(currentStats);
      }
      yield* publishChargingEvent(changeResult.events[0], pubSub);
      yield* waitForRampUp(changeResult.waitSeconds);
      const completed = completeAmpereChange(currentState);
      currentState = completed.state;
      if (completed.events.length > 0) {
        yield* publishChargingEvent(completed.events[0], pubSub);
      }
      return { state: currentState, stats: currentStats };
    }

    // No change
    return { state: controlState, stats: sessionStats };
  });
