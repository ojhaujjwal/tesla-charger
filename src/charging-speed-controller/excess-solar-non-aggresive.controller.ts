import { Effect } from "effect";
import { InadequateDataToDetermineSpeedError, type ChargingSpeedController } from "./types.js";
import type { IDataAdapter } from "../data-adapter/types.js";

/**
 * A decorator controller that stabilizes increases in charging speed.
 * 
 * Key features:
 * - Tracks raw data values to detect when the inverter actually sends fresh data
 * - Only increases speed when we have N fresh readings that all support the increase
 * - Immediately decreases when solar drops (safety first)
 * 
 * This prevents reacting to stale data that the inverter might return multiple times.
 */
export class ExcessSolarNonAggresiveController implements ChargingSpeedController {
  // History of {speed, dataSignature} for each fresh read
  private readHistory: { speed: number; dataSignature: string }[] = [];
  private lastAppliedSpeed = 0;
  private lastDataSignature: string | null = null;

  public constructor(
    private readonly baseController: ChargingSpeedController,
    private readonly dataAdapter: IDataAdapter,
    private readonly config: { requiredConsistentReads: number } = { requiredConsistentReads: 3 }
  ) { }

  public determineChargingSpeed(currentChargingSpeed: number): Effect.Effect<number, InadequateDataToDetermineSpeedError> {
    const deps = this;

    return Effect.gen(function* () {
      // Get candidate speed from base controller
      const candidateSpeed = yield* deps.baseController.determineChargingSpeed(currentChargingSpeed);

      // Get raw data to create a signature for detecting fresh vs stale data
      const rawData = yield* deps.dataAdapter.queryLatestValues(['export_to_grid', 'current_production', 'current_load']);
      const dataSignature = `${rawData.export_to_grid}:${rawData.current_production}:${rawData.current_load}`;

      // Check if this is fresh data (different from last read)
      const isFreshData = dataSignature !== deps.lastDataSignature;
      deps.lastDataSignature = dataSignature;

      // Only record fresh data into history
      if (isFreshData) {
        deps.readHistory.push({ speed: candidateSpeed, dataSignature });
        if (deps.readHistory.length > deps.config.requiredConsistentReads) {
          deps.readHistory.shift();
        }
      }

      // For decreases: apply immediately (safety first)
      if (candidateSpeed < deps.lastAppliedSpeed) {
        deps.lastAppliedSpeed = candidateSpeed;
        return candidateSpeed;
      }

      // For increases: only apply if we have enough FRESH readings that all support the increase
      if (candidateSpeed > deps.lastAppliedSpeed) {
        const hasEnoughFreshReads = deps.readHistory.length >= deps.config.requiredConsistentReads;
        const allReadingsSupportIncrease = deps.readHistory.every(r => r.speed >= candidateSpeed);

        if (hasEnoughFreshReads && allReadingsSupportIncrease) {
          deps.lastAppliedSpeed = candidateSpeed;
          return candidateSpeed;
        }

        // Not enough fresh consistent readings yet
        return deps.lastAppliedSpeed;
      }

      // No change needed
      return deps.lastAppliedSpeed;
    }).pipe(
      Effect.catchTags({
        'DataNotAvailable': () => Effect.fail(new InadequateDataToDetermineSpeedError()),
        'SourceNotAvailable': () => Effect.fail(new InadequateDataToDetermineSpeedError()),
      })
    );
  }
}
