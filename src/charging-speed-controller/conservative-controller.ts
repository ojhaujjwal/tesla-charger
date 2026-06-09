import { Effect, Layer } from "effect";
import { DataAdapter } from "../data-adapter/types.js";
import { ChargingSpeedController, InadequateDataToDetermineSpeedError } from "./types.js";
import { clampAmpere, Voltage } from "../domain/brands.js";
import type { Ampere } from "../domain/brands.js";

export const ConservativeControllerLayer = (
  config: {
    bufferPower?: number;
  } = {}
) =>
  Layer.effect(
    ChargingSpeedController,
    Effect.gen(function* () {
      const dataAdapter = yield* DataAdapter;
      const bufferPower = config.bufferPower ?? 100;

      return {
        determineChargingSpeed: Effect.fn("determineChargingSpeed")(
          function* (currentChargingSpeed: Ampere) {
            const { voltage: rawVoltage, current_load: currentLoad } = yield* dataAdapter.queryLatestValues([
              "voltage",
              "current_load"
            ]);

            const voltage = Voltage(rawVoltage);

            const lowestSolarProduction = yield* dataAdapter.getLowestValueInLastXMinutes("current_production", 30);

            yield* Effect.log("[ConservativeController] raw result:", {
              lowestSolarProduction,
              currentLoad,
              currentChargingSpeed,
              voltage
            });

            const value = Math.floor(
              (lowestSolarProduction - currentLoad + currentChargingSpeed * voltage - bufferPower) / voltage
            );
            yield* Effect.log("[ConservativeController] calculated value:", { value });

            return clampAmpere(value);
          },
          (effect) =>
            effect.pipe(
              Effect.catchTags({
                DataNotAvailable: (err) => Effect.fail(new InadequateDataToDetermineSpeedError({ cause: err })),
                SourceNotAvailable: (err) => Effect.fail(new InadequateDataToDetermineSpeedError({ cause: err }))
              })
            )
        )
      };
    }).pipe(Effect.withSpan("ConservativeControllerLayer"))
  );
