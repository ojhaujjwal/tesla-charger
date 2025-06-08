import { Data, Effect } from "effect";

export class InadequateDataToDetermineSpeedError extends Data.TaggedError("InadequateDataToDetermineSpeed") {}


export type ChargingSpeedController = {
  determineChargingSpeed: (currentChargingSpeed: number) => Effect.Effect<number, InadequateDataToDetermineSpeedError>;
};
