import { Data } from "effect";

export class VehicleNotWakingUpError extends Data.TaggedError('VehicleNotWakingUp')<{
  wakeupAttempts: number;
}> {}
