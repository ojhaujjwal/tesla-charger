import { Effect, Layer } from "effect";
import { DataAdapter } from "../data-adapter/types.js";
import { ChargingSpeedController, InadequateDataToDetermineSpeedError } from "./types.js";
import { Ampere } from "../domain/brands.js";
import { clampAmpere } from "../domain/brands.js";

export const ExcessFeedInSolarControllerLayer = (config: { maxFeedInAllowed: number }) =>
  Layer.effect(
    ChargingSpeedController,
    Effect.gen(function* () {
      const dataAdapter = yield* DataAdapter;

      return {
        determineChargingSpeed: Effect.fn("determineChargingSpeed")(
          function* (currentChargingSpeed: Ampere) {
            const {
              voltage,
              export_to_grid: exportingToGrid,
              import_from_grid: importingFromGrid
            } = yield* dataAdapter.queryLatestValues(["voltage", "export_to_grid", "import_from_grid"]);

            const netExport = exportingToGrid - importingFromGrid;

            yield* Effect.log("netExport", netExport);

            const excessSolarProduced = netExport + currentChargingSpeed * voltage;
            const excessSolarGoingWaste = excessSolarProduced - config.maxFeedInAllowed;
            yield* Effect.log("excessSolarGoingWaste", excessSolarGoingWaste);

            return clampAmpere(Math.ceil(excessSolarGoingWaste / voltage / 2) * 2);
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
    }).pipe(Effect.withSpan("ExcessFeedInSolarControllerLayer"))
  );
