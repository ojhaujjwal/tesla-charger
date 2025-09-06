import { Effect } from "effect";
import { InadequateDataToDetermineSpeedError, type ChargingSpeedController } from "./types.js";

export class ExcessSolarNonAggresiveController implements ChargingSpeedController {
  private history: number[] = [];

  public constructor(
    private readonly baseController: ChargingSpeedController,
    private readonly config: { historyLength: number } = { historyLength: 3 }
  ) {}

  public determineChargingSpeed(currentChargingSpeed: number): Effect.Effect<number, InadequateDataToDetermineSpeedError> {
    const deps = this;

    return Effect.gen(function* () {
      // Get the candidate speed from the base controller
      const candidateSpeed = yield* deps.baseController.determineChargingSpeed(currentChargingSpeed);

        // Only add if different from last value
        if (deps.history.length === 0 || deps.history[deps.history.length - 1] !== candidateSpeed) {
          deps.history.push(candidateSpeed);
          if (deps.history.length > deps.config.historyLength) {
            deps.history.shift();
          }
        }

      return Math.min(...deps.history);
    });
  }
}
