import { Data, Effect } from "effect";

export type Field =
  | 'voltage'
  | 'current_production'
  | 'current_load'
  | 'daily_import'
  | 'export_to_grid'
  | 'import_from_grid';


export class DataNotAvailableError extends Data.TaggedError("DataNotAvailable") {
  public readonly message = 'No data found to determine the result.';
}
export class SourceNotAvailableError extends Data.TaggedError("SourceNotAvailable") {
  public readonly message = 'Could not connect to the Data Source. Check if the source is running.';
}

export type IDataAdapter<AuthContext> = {
  authenticate: () => Promise<AuthContext>;
  queryLatestValues<F extends Field>(fields: F[]): Effect.Effect<Record<F, number>, DataNotAvailableError | SourceNotAvailableError>;
  getLowestValueInLastXMinutes: (field: Field, minutes: number) => Effect.Effect<number, DataNotAvailableError | SourceNotAvailableError>;
};
