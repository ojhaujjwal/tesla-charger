import { Context, Effect } from "effect";
import { VehicleAsleepError, VehicleCommandFailedError, VehicleChargeCompleteError } from "./errors.js";
import type { Ampere } from "./brands.js";

export class ElectricVehicle extends Context.Service<
  ElectricVehicle,
  {
    readonly startCharging: () => Effect.Effect<
      void,
      VehicleAsleepError | VehicleCommandFailedError | VehicleChargeCompleteError
    >;
    readonly stopCharging: () => Effect.Effect<void, VehicleAsleepError | VehicleCommandFailedError>;
    readonly setAmpere: (
      ampere: Ampere
    ) => Effect.Effect<void, VehicleAsleepError | VehicleCommandFailedError | VehicleChargeCompleteError>;
    readonly wakeUpCar: () => Effect.Effect<void, VehicleCommandFailedError>;
  }
>()("@tesla-charger/Domain/ElectricVehicle") {}
