import { Context, Data, Effect } from "effect";
import type { Ampere } from "../domain/brands.js";

export class InadequateDataToDetermineSpeedError extends Data.TaggedError("InadequateDataToDetermineSpeed")<{
  readonly cause?: unknown;
}> {}

export class ChargingSpeedController extends Context.Service<
  ChargingSpeedController,
  {
    determineChargingSpeed(currentChargingSpeed: Ampere): Effect.Effect<Ampere, InadequateDataToDetermineSpeedError>;
  }
>()("@tesla-charger/ChargingSpeedController") {}
