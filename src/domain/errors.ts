import { Data } from "effect";

export class VehicleAsleepError extends Data.TaggedError("VehicleAsleepError") {
  public override readonly message = "Vehicle is asleep";
}

export class VehicleCommandFailedError extends Data.TaggedError("VehicleCommandFailed")<{
  readonly message: string;
  readonly stderr?: string;
}> {}

export class ChargeStateQueryFailedError extends Data.TaggedError("ChargeStateQueryFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
