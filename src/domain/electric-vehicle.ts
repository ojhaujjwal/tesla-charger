import { Effect } from "effect";
import { VehicleAsleepError, VehicleCommandFailedError } from "./errors.js";
import type { Ampere } from "./brands.js";

export type ElectricVehicle = {
  readonly startCharging: () => Effect.Effect<void, VehicleAsleepError | VehicleCommandFailedError>;
  readonly stopCharging: () => Effect.Effect<void, VehicleAsleepError | VehicleCommandFailedError>;
  readonly setAmpere: (ampere: Ampere) => Effect.Effect<void, VehicleAsleepError | VehicleCommandFailedError>;
};
