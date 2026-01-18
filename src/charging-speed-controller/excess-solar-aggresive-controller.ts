import { DataAdapter } from "../data-adapter/types.js";
import { ChargingSpeedController, InadequateDataToDetermineSpeedError } from "./types.js";
import { Effect, Layer } from "effect";

export const ExcessSolarAggresiveControllerLayer = (config: {
  bufferPower: number;
  multipleOf: number;
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

        const excessSolar = netExport - config.bufferPower + (currentChargingSpeed * voltage);

        if (excessSolar > 0) {
          yield* Effect.log('[ExcessSolarAggresiveController] raw result:', { excessSolar, netExport });
        }

        if ((excessSolar / voltage) >= 32) {
          return 32;
        }

        // round to nearest multiple of parameter
        return Math.max(0, Math.floor((excessSolar / voltage) / config.multipleOf) * config.multipleOf);
      }).pipe(
        Effect.catchTags({
          'DataNotAvailable': (err) => Effect.log(err).pipe(Effect.flatMap(() => Effect.fail(new InadequateDataToDetermineSpeedError()))),
          'SourceNotAvailable': (err) => Effect.log(err).pipe(Effect.flatMap(() => Effect.fail(new InadequateDataToDetermineSpeedError()))),
        })
      )
    };
  })
);
