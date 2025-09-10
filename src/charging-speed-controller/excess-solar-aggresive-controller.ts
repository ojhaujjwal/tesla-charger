import type { IDataAdapter } from "../data-adapter/types.js";
import { InadequateDataToDetermineSpeedError, type ChargingSpeedController } from "./types.js";
import { Effect } from "effect";

export class ExcessSolarAggresiveController implements ChargingSpeedController {
  public constructor(
    private readonly dataAdapter: IDataAdapter,
    private readonly config: {
      bufferPower: number;
    }
  ) { }

  public determineChargingSpeed(currentChargingSpeed: number): Effect.Effect<number, InadequateDataToDetermineSpeedError> {
    // that
    const deps = this;

    return Effect.gen(function* () {
        const {
          voltage,
          export_to_grid: exportingToGrid,
          import_from_grid: importingFromGrid
        } = yield* deps.dataAdapter.queryLatestValues(['voltage', 'export_to_grid', 'import_from_grid']);

        const netExport = exportingToGrid - importingFromGrid;

        const excessSolar = netExport - deps.config.bufferPower + (currentChargingSpeed * voltage);
        
        if (excessSolar > 0) {
          yield* Effect.log('[ExcessSolarAggresiveController] raw result:', { excessSolar, netExport });
        }

        if ((excessSolar / voltage) >= 32) {
          return 32;
        }

        // round to nearest multiple of 3
        return Math.max(0, Math.floor(excessSolar / voltage / 3) * 3);
      }.bind(this))
        .pipe(
          Effect.catchTags({
            'DataNotAvailable': (err) => Effect.log(err).pipe(Effect.flatMap(() => Effect.fail(new InadequateDataToDetermineSpeedError()))),
            'SourceNotAvailable': (err) => Effect.log(err).pipe(Effect.flatMap(() => Effect.fail(new InadequateDataToDetermineSpeedError()))),
          })
        );
  }
}
