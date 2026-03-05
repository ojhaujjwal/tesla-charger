import { DataAdapter } from "../data-adapter/types.js";
import { ChargingSpeedController, InadequateDataToDetermineSpeedError } from "./types.js";
import { Effect, Layer } from "effect";

export const BatteryAwareChargingSpeedControllerLayer = (
  baseControllerLayer: Layer.Layer<ChargingSpeedController>
): Layer.Layer<ChargingSpeedController> =>
  // @ts-expect-error - Layer type simplification
  Layer.effect(
    ChargingSpeedController,
    Effect.gen(function* () {
      const baseController = yield* Effect.provide(ChargingSpeedController, baseControllerLayer);
      const dataAdapter = yield* DataAdapter;

      return {
        determineChargingSpeed: (currentChargingSpeed: number) =>
          Effect.gen(function* () {
            const { battery_power } = yield* dataAdapter.queryLatestValues(['battery_power']);

            if (battery_power > 0) {
              yield* Effect.logDebug('BatteryAware: battery discharging, not charging car');
              return Effect.succeed(0);
            }

            return baseController.determineChargingSpeed(currentChargingSpeed);
          }).pipe(
            Effect.flatten,
            Effect.catchTags({
              DataNotAvailable: (err: Error) =>
                Effect.fail(new InadequateDataToDetermineSpeedError({ cause: err })),
              SourceNotAvailable: (err: Error) =>
                Effect.fail(new InadequateDataToDetermineSpeedError({ cause: err })),
            })
          ),
      };
    })
  );
