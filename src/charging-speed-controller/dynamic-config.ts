import { Context, Effect, Layer, Ref } from "effect";

export class DynamicChargingConfig extends Context.Tag("@tesla-charger/DynamicChargingConfig")<
  DynamicChargingConfig,
  {
    readonly getBufferPower: Effect.Effect<number>;
    readonly setBufferPower: (n: number) => Effect.Effect<void>;
  }
>() {}

export const DynamicChargingConfigLayer = (initialBufferPower: number) =>
  Layer.effect(
    DynamicChargingConfig,
    Effect.gen(function* () {
      const ref = yield* Ref.make(initialBufferPower);
      return {
        getBufferPower: Ref.get(ref),
        setBufferPower: (n: number) => Ref.set(ref, n)
      };
    })
  );
