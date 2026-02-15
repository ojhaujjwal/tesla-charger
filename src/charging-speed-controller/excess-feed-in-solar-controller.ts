import { Effect, Layer } from "effect";
import { DataAdapter } from "../data-adapter/types.js";
import { ChargingSpeedController, InadequateDataToDetermineSpeedError } from "./types.js";

export const ExcessFeedInSolarControllerLayer = (config: {
  maxFeedInAllowed: number;
}) => Layer.effect(
  ChargingSpeedController,
  Effect.gen(function* () {
    const dataAdapter = yield* DataAdapter;

    return {
      determineChargingSpeed: (currentChargingSpeed: number) => Effect.gen(function* () {
        const {
          voltage,
          export_to_grid: exportingToGrid,
          import_from_grid: importingFromGrid
        } = yield* dataAdapter.queryLatestValues(['voltage', 'export_to_grid', 'import_from_grid']);

        const netExport = exportingToGrid - importingFromGrid;

        console.log('netExport', netExport);

        const excessSolarProduced = netExport + (currentChargingSpeed * voltage);
        const excessSolarGoingWaste = excessSolarProduced - config.maxFeedInAllowed;
        console.log('excessSolarGoingWaste', excessSolarGoingWaste);

        // round to nearest multiple of 2
        return Math.ceil((excessSolarGoingWaste / voltage) / 2) * 2;
      }).pipe(
        Effect.catchTags({
          'DataNotAvailable': (err) => Effect.fail(new InadequateDataToDetermineSpeedError({ cause: err })),
          'SourceNotAvailable': (err) => Effect.fail(new InadequateDataToDetermineSpeedError({ cause: err })),
        })
      )
    };
  })
);
