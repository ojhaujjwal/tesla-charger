import { Effect, Layer } from "effect";
import { ChargingSpeedController, InadequateDataToDetermineSpeedError } from "./types.js";
import { DataAdapter } from "../data-adapter/types.js";

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
export const ExcessSolarNonAggresiveControllerLayer = (config: {
  baseControllerLayer: Layer.Layer<ChargingSpeedController, never, DataAdapter>;
  requiredConsistentReads?: number;
}) => Layer.effect(
  ChargingSpeedController,
  Effect.gen(function* () {
    const baseController = yield* Effect.provide(ChargingSpeedController, config.baseControllerLayer);
    const dataAdapter = yield* DataAdapter;
    const requiredConsistentReads = config.requiredConsistentReads ?? 3;

    // State 
    const readHistory: { speed: number; dataSignature: string }[] = [];
    let lastAppliedSpeed = 0;
    let lastDataSignature: string | null = null;

    return {
      determineChargingSpeed: (currentChargingSpeed: number) => Effect.gen(function* () {
        // Get candidate speed from base controller
        const candidateSpeed = yield* baseController.determineChargingSpeed(currentChargingSpeed);

        // Get raw data to create a signature for detecting fresh vs stale data
        const rawData = yield* dataAdapter.queryLatestValues(['export_to_grid', 'current_production', 'current_load']);
        const dataSignature = `${rawData.export_to_grid}:${rawData.current_production}:${rawData.current_load}`;

        // Check if this is fresh data (different from last read)
        const isFreshData = dataSignature !== lastDataSignature;
        lastDataSignature = dataSignature;

        // Only record fresh data into history
        if (isFreshData) {
          readHistory.push({ speed: candidateSpeed, dataSignature });
          if (readHistory.length > requiredConsistentReads) {
            readHistory.shift();
          }
        }

        // For decreases: apply immediately (safety first)
        if (candidateSpeed < lastAppliedSpeed) {
          lastAppliedSpeed = candidateSpeed;
          return candidateSpeed;
        }

        // For increases: only apply if we have enough FRESH readings that all support the increase
        if (candidateSpeed > lastAppliedSpeed) {
          const hasEnoughFreshReads = readHistory.length >= requiredConsistentReads;
          const allReadingsSupportIncrease = readHistory.every(r => r.speed >= candidateSpeed);

          if (hasEnoughFreshReads && allReadingsSupportIncrease) {
            lastAppliedSpeed = candidateSpeed;
            return candidateSpeed;
          }

          // Not enough fresh consistent readings yet
          return lastAppliedSpeed;
        }

        // No change needed
        return lastAppliedSpeed;
      }).pipe(
        Effect.catchTags({
          'DataNotAvailable': () => Effect.fail(new InadequateDataToDetermineSpeedError()),
          'SourceNotAvailable': () => Effect.fail(new InadequateDataToDetermineSpeedError()),
        })
      )
    };
  })
);
