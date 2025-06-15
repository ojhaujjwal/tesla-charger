import { Effect } from "effect";
import type { IDataAdapter } from "../data-adapter/types.js";
import { InadequateDataToDetermineSpeedError, type ChargingSpeedController } from "./types.js";

export class ConservativeController implements ChargingSpeedController {

  public constructor(
    private readonly dataAdapter: IDataAdapter,
    private readonly config: {
      bufferPower: number;
    } = { bufferPower: 100 }
  ) { }

  public determineChargingSpeed(currentChargingSpeed: number): Effect.Effect<number, InadequateDataToDetermineSpeedError> {
    const deps = this;

    return Effect.gen(function* () {
        const {
          voltage,
          current_load: currentLoad,
        } = yield* deps.dataAdapter.queryLatestValues(['voltage', 'current_load']);

        const lowestSolarProduction = yield* deps.dataAdapter.getLowestValueInLastXMinutes('current_production', 30);
    
        return Math.floor((lowestSolarProduction - currentLoad - currentChargingSpeed * voltage - deps.config.bufferPower) / voltage);
      }.bind(this))
        .pipe(
          Effect.catchTags({
            'DataNotAvailable': (err) => Effect.log(err).pipe(Effect.flatMap(() => Effect.fail(new InadequateDataToDetermineSpeedError()))),
            'SourceNotAvailable': (err) => Effect.log(err).pipe(Effect.flatMap(() => Effect.fail(new InadequateDataToDetermineSpeedError()))),
          })
        );
  }
}
