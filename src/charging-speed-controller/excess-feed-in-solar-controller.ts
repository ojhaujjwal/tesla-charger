import { Effect } from "effect";
import type { IDataAdapter } from "../data-adapter/types.js";
import { InadequateDataToDetermineSpeedError, type ChargingSpeedController } from "./types.js";

export class ExcessFeedInSolarController implements ChargingSpeedController {
  public constructor(
    private readonly dataAdapter: IDataAdapter<unknown>,
    private readonly config: {
      maxFeedInAllowed: number;
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

        console.log('netExport', netExport);

        const excessSolarProduced = netExport + (currentChargingSpeed * voltage);
        const excessSolarGoingWaste = excessSolarProduced - deps.config.maxFeedInAllowed;
        console.log('excessSolarGoingWaste', excessSolarGoingWaste);

        // round to nearest multiple of 2
        return Math.ceil((excessSolarGoingWaste / voltage) / 2) * 2;
      }.bind(this))
        .pipe(
          Effect.catchTags({
            'DataNotAvailable': (err) => Effect.log(err).pipe(Effect.flatMap(() => Effect.fail(new InadequateDataToDetermineSpeedError()))),
            'SourceNotAvailable': (err) => Effect.log(err).pipe(Effect.flatMap(() => Effect.fail(new InadequateDataToDetermineSpeedError()))),
          })
        );
    }
}
