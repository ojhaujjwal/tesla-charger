import { Effect, Layer } from "effect";
import { DataAdapter } from "../data-adapter/types.js";
import { ChargingSpeedController, InadequateDataToDetermineSpeedError } from "./types.js";
import { Ampere, Voltage } from "../domain/brands.js";

export const FixedSpeedControllerLayer = (config: { fixedSpeed: Ampere; bufferPower: number }) =>
  Layer.effect(
    ChargingSpeedController,
    Effect.gen(function* () {
      const dataAdapter = yield* DataAdapter;

      return {
        determineChargingSpeed: Effect.fn("determineChargingSpeed")(
          function* (currentChargingSpeed: Ampere) {
            const {
              voltage: rawVoltage,
              export_to_grid: exportingToGrid,
              import_from_grid: importingFromGrid
            } = yield* dataAdapter.queryLatestValues(["voltage", "export_to_grid", "import_from_grid"]);

            const voltage = Voltage(rawVoltage);

            const netExport = exportingToGrid - importingFromGrid;
            const currentChargingPower = currentChargingSpeed * voltage;

            const availablePower = netExport + currentChargingPower - config.bufferPower;
            const desiredChargingPower = config.fixedSpeed * voltage;

            if (availablePower >= desiredChargingPower) {
              return config.fixedSpeed;
            }

            return Ampere(0);
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
    }).pipe(Effect.withSpan("FixedSpeedControllerLayer"))
  );
