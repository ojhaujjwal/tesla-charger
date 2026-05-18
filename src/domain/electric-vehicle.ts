import { Context, Effect } from "effect";
import { VehicleAsleepError, VehicleCommandFailedError } from "./errors.js";

export class ElectricVehicle extends Context.Service<
  ElectricVehicle,
  {
    readonly startCharging: () => Effect.Effect<void, VehicleAsleepError | VehicleCommandFailedError>;
    readonly stopCharging: () => Effect.Effect<void, VehicleAsleepError | VehicleCommandFailedError>;
    readonly setAmpere: (ampere: number) => Effect.Effect<void, VehicleAsleepError | VehicleCommandFailedError>;
  }
>()("@tesla-charger/Domain/ElectricVehicle") {}
