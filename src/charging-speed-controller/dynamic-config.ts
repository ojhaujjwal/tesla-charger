import { Context, Effect, Layer, Ref } from "effect";
import type { Watt } from "../domain/brands.js";

export class DynamicChargingConfig extends Context.Service<
  DynamicChargingConfig,
  {
    readonly getBufferPower: Effect.Effect<Watt>;
    readonly setBufferPower: (n: Watt) => Effect.Effect<void>;
  }
>()("@tesla-charger/DynamicChargingConfig") {}

export const DynamicChargingConfigLayer = (initialBufferPower: Watt) =>
  Layer.effect(
    DynamicChargingConfig,
    Effect.gen(function* () {
      const ref = yield* Ref.make(initialBufferPower);
      return {
        getBufferPower: Ref.get(ref),
        setBufferPower: (n: Watt) => Ref.set(ref, n)
      };
    })
  );
