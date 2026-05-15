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
}) =>
  Layer.effect(
    ChargingSpeedController,
    Effect.gen(function* () {
      const baseController = yield* Effect.provide(ChargingSpeedController, config.baseControllerLayer);
      const dataAdapter = yield* DataAdapter;
      const requiredConsistentReads = config.requiredConsistentReads ?? 3;

      const readHistory: { speed: number; dataSignature: string }[] = [];
      let lastAppliedSpeed = 0;
      let lastDataSignature: string | null = null;

      return {
        determineChargingSpeed: Effect.fn("determineChargingSpeed")(
          function* (currentChargingSpeed: number) {
            const candidateSpeed = yield* baseController.determineChargingSpeed(currentChargingSpeed);

            const rawData = yield* dataAdapter.queryLatestValues([
              "export_to_grid",
              "current_production",
              "current_load"
            ]);
            const dataSignature = `${rawData.export_to_grid}:${rawData.current_production}:${rawData.current_load}`;

            const isFreshData = dataSignature !== lastDataSignature;
            lastDataSignature = dataSignature;

            if (isFreshData) {
              readHistory.push({ speed: candidateSpeed, dataSignature });
              if (readHistory.length > requiredConsistentReads) {
                readHistory.shift();
              }
            }

            if (candidateSpeed < lastAppliedSpeed) {
              lastAppliedSpeed = candidateSpeed;
              return candidateSpeed;
            }

            if (candidateSpeed > lastAppliedSpeed) {
              const hasEnoughFreshReads = readHistory.length >= requiredConsistentReads;
              const allReadingsSupportIncrease = readHistory.every((r) => r.speed >= candidateSpeed);
              const isFirstFreshRead = readHistory.length === 1;

              if ((hasEnoughFreshReads && allReadingsSupportIncrease) || isFirstFreshRead) {
                lastAppliedSpeed = candidateSpeed;
                return candidateSpeed;
              }

              return lastAppliedSpeed;
            }

            return lastAppliedSpeed;
          },
          (effect) =>
            effect.pipe(
              Effect.catchTags({
                DataNotAvailable: (err) => Effect.fail(new InadequateDataToDetermineSpeedError({ cause: err })),
                SourceNotAvailable: (err) => Effect.fail(new InadequateDataToDetermineSpeedError({ cause: err }))
              })
            )
        )
      };
    }).pipe(Effect.withSpan("ExcessSolarNonAggresiveControllerLayer"))
  );
