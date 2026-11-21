import { Effect, Layer, Ref } from "effect";
import { ChargingSpeedController, InadequateDataToDetermineSpeedError } from "./types.js";
import { DynamicChargingConfig } from "./dynamic-config.js";
import { DataAdapter } from "../data-adapter/types.js";
import { Ampere } from "../domain/brands.js";

type ReadHistoryEntry = { speed: Ampere; dataSignature: string };

type ControllerState = {
  readHistory: ReadonlyArray<ReadHistoryEntry>;
  lastAppliedSpeed: Ampere;
  lastDataSignature: string | null;
};

export const ExcessSolarNonAggresiveControllerLayer = (config: {
  baseControllerLayer: Layer.Layer<ChargingSpeedController, never, DataAdapter | DynamicChargingConfig>;
  requiredConsistentReads?: number;
}) =>
  Layer.effect(
    ChargingSpeedController,
    Effect.gen(function* () {
      const baseController = yield* Effect.provide(ChargingSpeedController, config.baseControllerLayer);
      const dataAdapter = yield* DataAdapter;
      const requiredConsistentReads = config.requiredConsistentReads ?? 3;

      const stateRef = yield* Ref.make<ControllerState>({
        readHistory: [],
        lastAppliedSpeed: Ampere(0),
        lastDataSignature: null
      });

      return {
        determineChargingSpeed: Effect.fn("determineChargingSpeed")(
          function* (currentChargingSpeed: Ampere) {
            const candidateSpeed = yield* baseController.determineChargingSpeed(currentChargingSpeed);

            const rawData = yield* dataAdapter.queryLatestValues([
              "export_to_grid",
              "current_production",
              "current_load"
            ]);
            const dataSignature = `${rawData.export_to_grid}:${rawData.current_production}:${rawData.current_load}`;

            const lastAppliedSpeed = yield* Ref.modify(stateRef, (previous) => {
              const isFreshData = dataSignature !== previous.lastDataSignature;

              let readHistory = previous.readHistory;
              if (isFreshData) {
                const withCandidate = [...readHistory, { speed: candidateSpeed, dataSignature }];
                readHistory = withCandidate.length > requiredConsistentReads ? withCandidate.slice(1) : withCandidate;
              }

              let lastAppliedSpeed = previous.lastAppliedSpeed;

              if (candidateSpeed < lastAppliedSpeed) {
                lastAppliedSpeed = candidateSpeed;
              } else if (candidateSpeed > lastAppliedSpeed) {
                const hasEnoughFreshReads = readHistory.length >= requiredConsistentReads;
                const allReadingsSupportIncrease = readHistory.every((r) => r.speed >= candidateSpeed);
                const isFirstFreshRead = readHistory.length === 1;

                if ((hasEnoughFreshReads && allReadingsSupportIncrease) || isFirstFreshRead) {
                  lastAppliedSpeed = candidateSpeed;
                }
              }

              return [lastAppliedSpeed, { readHistory, lastAppliedSpeed, lastDataSignature: dataSignature }];
            });

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
