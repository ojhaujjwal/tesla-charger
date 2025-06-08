import { Data } from "effect";

export class VehicleAsleepError extends Data.TaggedError('VehicleAsleepError') {
  public message = 'Vehicle is asleep';
}
