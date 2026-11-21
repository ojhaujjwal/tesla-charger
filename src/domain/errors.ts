import { Data } from "effect";
import type { StateOfCharge } from "./brands.js";

export class VehicleAsleepError extends Data.TaggedError("VehicleAsleepError") {
  public override readonly message = "Vehicle is asleep";
}

export class VehicleCommandFailedError extends Data.TaggedError("VehicleCommandFailed")<{
  readonly message: string;
  readonly stderr?: string;
  readonly cause?: unknown;
}> {}

// Tesla rejects charge commands with "car could not execute command: complete"
// when the vehicle considers its charge finished (battery reached the
// configured charge limit). The client verifies the rejection against fresh
// vehicle data and attaches it here; both fields are absent when the
// verification query itself failed.
export class VehicleChargeCompleteError extends Data.TaggedError("VehicleChargeComplete")<{
  readonly message: string;
  readonly stderr?: string | undefined;
  readonly batteryLevel?: StateOfCharge;
  readonly chargeLimitSoc?: StateOfCharge;
}> {}

export class ChargeStateQueryFailedError extends Data.TaggedError("ChargeStateQueryFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
