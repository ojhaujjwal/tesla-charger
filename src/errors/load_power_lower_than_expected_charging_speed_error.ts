import { Data } from "effect";

export class LoadPowerLowerThanExpectedChargingSpeedError extends Data.TaggedError('LoadPowerLowerThanExpectedChargingSpeed') {}