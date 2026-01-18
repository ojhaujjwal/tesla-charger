import { Effect, Layer } from "effect";
import { DataAdapter } from "../data-adapter/types.js";
import { ChargingSpeedController, InadequateDataToDetermineSpeedError } from "./types.js";

export const ConservativeControllerLayer = (config: {
  bufferPower?: number;
} = {}) => Layer.effect(
  ChargingSpeedController,
  Effect.gen(function* () {
    const dataAdapter = yield* DataAdapter;
    const bufferPower = config.bufferPower ?? 100;

    return {
      determineChargingSpeed: (currentChargingSpeed: number) => Effect.gen(function* () {
        const {
          voltage,
          current_load: currentLoad,
        } = yield* dataAdapter.queryLatestValues(['voltage', 'current_load']);

        const lowestSolarProduction = yield* dataAdapter.getLowestValueInLastXMinutes('current_production', 30);

        yield* Effect.log('[ConservativeController] raw result:', { lowestSolarProduction, currentLoad, currentChargingSpeed, voltage });

        const value = Math.floor((lowestSolarProduction - currentLoad + currentChargingSpeed * voltage - bufferPower) / voltage);
        yield* Effect.log('[ConservativeController] calculated value:', { value });

        return value;
      }).pipe(
        Effect.catchTags({
          'DataNotAvailable': (err) => Effect.log(err).pipe(Effect.flatMap(() => Effect.fail(new InadequateDataToDetermineSpeedError()))),
          'SourceNotAvailable': (err) => Effect.log(err).pipe(Effect.flatMap(() => Effect.fail(new InadequateDataToDetermineSpeedError()))),
        })
      )
    };
  })
);
