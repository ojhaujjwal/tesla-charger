import type { IDataAdapter, DataNotAvailableError, SourceNotAvailableError } from "../data-adapter/types.js";
import { AbruptProductionDropError } from "../errors/abrupt-production-drop.error.js";
import { Duration, Effect, Schedule } from "effect";

export const watchForProductionDrop = (
  dataAdapter: IDataAdapter,
  currentProductionAtStart: number,
  timeInSeconds: number
): Effect.Effect<void, AbruptProductionDropError | DataNotAvailableError | SourceNotAvailableError> =>
  Effect.race(
    Effect.void.pipe(Effect.delay(Duration.seconds(timeInSeconds))),
    Effect.repeat(
      Effect.gen(function* () {
        const { current_production: currentProduction, import_from_grid: importingFromGrid } =
          yield* dataAdapter.queryLatestValues(["current_production", "import_from_grid"]);
        yield* Effect.logDebug("watching for sudden drop in production", {
          currentProduction,
          currentProductionAtStart,
          importingFromGrid
        });
        if (importingFromGrid > 0) {
          return yield* new AbruptProductionDropError({
            initialProduction: currentProductionAtStart,
            currentProduction
          });
        }
        return;
      }),
      Schedule.fixed(Duration.seconds(4))
    )
  );
