import { Effect } from "effect";
import type { IDataAdapter } from "../data-adapter/types.js";
import { InadequateDataToDetermineSpeedError, type ChargingSpeedController } from "./types.js";

export class FixedSpeedController implements ChargingSpeedController {
  public constructor(
    private readonly dataAdapter: IDataAdapter<unknown>,
    private readonly config: {
      fixedSpeed: number;
      bufferPower: number;
    }
  ) {
    if (config.fixedSpeed < 0 || config.fixedSpeed > 32) {
      throw new Error('Fixed speed must be between 0 and 32 amperes');
    }
  }

  public determineChargingSpeed(currentChargingSpeed: number): Effect.Effect<number, InadequateDataToDetermineSpeedError> {
      const deps = this;
  
      return Effect.gen(function* () {
          const {
            voltage,
            export_to_grid: exportingToGrid,
            import_from_grid: importingFromGrid
          } = yield* deps.dataAdapter.queryLatestValues(['voltage', 'export_to_grid', 'import_from_grid']);
  
          const netExport = exportingToGrid - importingFromGrid;
          const currentChargingPower = currentChargingSpeed * voltage;
          
          // Calculate available power for charging
          const availablePower = netExport + currentChargingPower - deps.config.bufferPower;
          const desiredChargingPower = deps.config.fixedSpeed * voltage;

          // Only charge at fixed speed if we have enough power available
          if (availablePower >= desiredChargingPower) {
            return deps.config.fixedSpeed;
          }

          return 0;
        }.bind(this))
          .pipe(
            Effect.catchTags({
              'DataNotAvailable': (err) => Effect.log(err).pipe(Effect.flatMap(() => Effect.fail(new InadequateDataToDetermineSpeedError()))),
              'SourceNotAvailable': (err) => Effect.log(err).pipe(Effect.flatMap(() => Effect.fail(new InadequateDataToDetermineSpeedError()))),
            })
          );
    }
}
