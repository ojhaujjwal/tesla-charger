import type { ChargingControlState } from "../domain/charging-session.js";
import type { IDataAdapter, DataNotAvailableError, SourceNotAvailableError } from "../data-adapter/types.js";
import { BatteryStateManager } from "../battery-state-manager.js";
import { Effect } from "effect";

export const verifyCharging = (
  dataAdapter: IDataAdapter,
  batteryStateManager: BatteryStateManager["Service"],
  controlState: ChargingControlState,
  onBatteryComplete: Effect.Effect<void>
): Effect.Effect<void, DataNotAvailableError | SourceNotAvailableError> =>
  Effect.gen(function* () {
    const { current_load: currentLoad, voltage } = yield* dataAdapter.queryLatestValues(["current_load", "voltage"]);
    const currentLoadAmpere = currentLoad / voltage;

    if (controlState.status !== "Charging") return;
    const expectedAmpere = controlState.ampere;
    if (expectedAmpere <= 0) return;

    if (currentLoadAmpere < expectedAmpere) {
      yield* Effect.logDebug("load power not expected", {
        currentLoad,
        voltage,
        expectedAmpere
      });
    }

    const batteryState = batteryStateManager.get();
    if (batteryState && batteryState.batteryLevel >= batteryState.chargeLimitSoc) {
      yield* Effect.log("Charge complete - battery level reached charge limit", {
        batteryLevel: batteryState.batteryLevel,
        chargeLimitSoc: batteryState.chargeLimitSoc
      });
      yield* onBatteryComplete;
    }
  });
