import { Context, Data, Effect } from "effect";

export class InadequateDataToDetermineSpeedError extends Data.TaggedError("InadequateDataToDetermineSpeed")<{
  readonly cause?: unknown;
}> {}

export class ChargingSpeedController extends Context.Service<
  ChargingSpeedController,
  {
    determineChargingSpeed(currentChargingSpeed: number): Effect.Effect<number, InadequateDataToDetermineSpeedError>;
  }
>()("@tesla-charger/ChargingSpeedController") {}
