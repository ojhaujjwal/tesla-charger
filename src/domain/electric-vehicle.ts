import { Context, Effect } from "effect";
import { VehicleAsleepError, VehicleCommandFailedError } from "./errors.js";

export class ElectricVehicle extends Context.Tag("@tesla-charger/Domain/ElectricVehicle")<
  ElectricVehicle,
  {
    readonly startCharging: () => Effect.Effect<void, VehicleAsleepError | VehicleCommandFailedError>;
    readonly stopCharging: () => Effect.Effect<void, VehicleAsleepError | VehicleCommandFailedError>;
    readonly setAmpere: (ampere: number) => Effect.Effect<void, VehicleAsleepError | VehicleCommandFailedError>;
  }
>() {}
