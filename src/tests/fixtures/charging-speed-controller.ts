import { Effect, Layer } from "effect";
import { ChargingSpeedController } from "../../charging-speed-controller/types.js";
import type { Ampere } from "../../domain/brands.js";

export type ChargingSpeedControllerTest = {
  readonly layer: Layer.Layer<ChargingSpeedController>;
  readonly calls: ReadonlyArray<Ampere>;
};

/**
 * Scripted speed controller: queued answers are consumed in call order and the
 * last answer keeps repeating. `calls` records the current speed of each call.
 */
export const makeChargingSpeedControllerTest = (speeds: ReadonlyArray<Ampere>): ChargingSpeedControllerTest => {
  if (speeds.length === 0) {
    throw new Error("makeChargingSpeedControllerTest requires at least one speed");
  }

  const queue = [...speeds];
  let last = queue[queue.length - 1];
  const calls: Array<Ampere> = [];

  const determineChargingSpeed = (current: Ampere) => {
    calls.push(current);
    const next = queue.shift() ?? last;
    last = next;
    return Effect.succeed(next);
  };

  return {
    layer: Layer.succeed(ChargingSpeedController, { determineChargingSpeed }),
    calls
  };
};
