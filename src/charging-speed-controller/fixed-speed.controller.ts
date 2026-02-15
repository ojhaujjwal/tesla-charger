import { Effect, Layer } from "effect";
import { DataAdapter } from "../data-adapter/types.js";
import { ChargingSpeedController, InadequateDataToDetermineSpeedError } from "./types.js";

export const FixedSpeedControllerLayer = (config: {
  fixedSpeed: number;
  bufferPower: number;
}) => Layer.effect(
  ChargingSpeedController,
  Effect.gen(function* () {
    const dataAdapter = yield* DataAdapter;

    if (config.fixedSpeed < 0 || config.fixedSpeed > 32) {
      throw new Error('Fixed speed must be between 0 and 32 amperes');
    }

    return {
      determineChargingSpeed: (currentChargingSpeed: number) => Effect.gen(function* () {
        const {
          voltage,
          export_to_grid: exportingToGrid,
          import_from_grid: importingFromGrid
        } = yield* dataAdapter.queryLatestValues(['voltage', 'export_to_grid', 'import_from_grid']);

        const netExport = exportingToGrid - importingFromGrid;
        const currentChargingPower = currentChargingSpeed * voltage;

        // Calculate available power for charging
        const availablePower = netExport + currentChargingPower - config.bufferPower;
        const desiredChargingPower = config.fixedSpeed * voltage;

        // Only charge at fixed speed if we have enough power available
        if (availablePower >= desiredChargingPower) {
          return config.fixedSpeed;
        }

        return 0;
      }).pipe(
        Effect.catchTags({
          'DataNotAvailable': (err) => Effect.fail(new InadequateDataToDetermineSpeedError({ cause: err })),
          'SourceNotAvailable': (err) => Effect.fail(new InadequateDataToDetermineSpeedError({ cause: err })),
        })
      )
    };
  })
);
