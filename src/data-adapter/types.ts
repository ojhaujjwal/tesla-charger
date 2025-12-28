import { Context, Data, Effect, Schema } from "effect";


// Define the Field schema
export const FieldSchema = Schema.Union(
  Schema.Literal("voltage"),
  Schema.Literal("current_production"),
  Schema.Literal("current_load"),
  Schema.Literal("daily_import"),
  Schema.Literal("export_to_grid"),
  Schema.Literal("import_from_grid")
);

export type Field = Schema.Schema.Type<typeof FieldSchema>;

export class DataNotAvailableError extends Data.TaggedError("DataNotAvailable") {
  public override readonly message = 'No data found to determine the result.';
}
export class SourceNotAvailableError extends Data.TaggedError("SourceNotAvailable") {
  public override readonly message = 'Could not connect to the Data Source. Check if the source is running.';
}

export class DataAdapter extends Context.Tag("DataAdapter")<
   DataAdapter,
  {
    readonly queryLatestValues: <F extends Field>(fields: F[]) => Effect.Effect<Record<F, number>, DataNotAvailableError | SourceNotAvailableError>;
    readonly getLowestValueInLastXMinutes: (field: Field, minutes: number) => Effect.Effect<number, DataNotAvailableError | SourceNotAvailableError>;
  }>
(){}


export type IDataAdapter = Context.Tag.Service<typeof DataAdapter>;
