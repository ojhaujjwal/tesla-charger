import { Duration, Effect, Layer, Redacted, Schema } from "effect";
import { HttpBody, HttpClient } from "effect/http";
import { AppConfig } from "../config.js";
import { DataAdapter, DataNotAvailableError, SourceNotAvailableError, type Field } from "./types.js";

const TIMEOUT_MS = 10_000;

export const InfluxFieldSchema = Schema.Union([
  Schema.Literal("phase_a_voltage"),
  Schema.Literal("total_active_power"),
  Schema.Literal("load_power"),
  Schema.Literal("daily_import_from_grid"),
  Schema.Literal("export_to_grid"),
  Schema.Literal("import_from_grid"),
  Schema.Literal("battery_power")
]);

export type InfluxField = Schema.Schema.Type<typeof InfluxFieldSchema>;

function isFieldRecord<F extends string>(obj: Record<string, number>, fields: readonly F[]): obj is Record<F, number> {
  return fields.every((field) => field in obj && typeof obj[field] === "number");
}

const fieldMap: Record<Field, InfluxField> = {
  voltage: "phase_a_voltage",
  current_production: "total_active_power",
  current_load: "load_power",
  daily_import: "daily_import_from_grid",
  export_to_grid: "export_to_grid",
  import_from_grid: "import_from_grid",
  battery_power: "battery_power"
};

const parseCsv = Effect.fn("parseCsv")(function* <F extends Field>(rows: string[], fields: readonly F[]) {
  if (rows.length === 0 || rows.length < 2) {
    yield* Effect.logError("No data rows found in CSV");
    return yield* new DataNotAvailableError();
  }

  const headers = rows[0].split(",");
  const data = rows.slice(1, 1 + fields.length).map((row) => {
    const values = row.split(",");
    return headers.reduce<Record<string, string>>((acc, header, index) => {
      acc[header] = values[index];
      return acc;
    }, {});
  });

  const result: Record<string, number> = {};

  for (const row of data) {
    const field = yield* Schema.decodeUnknownEffect(InfluxFieldSchema)(row._field).pipe(
      Effect.catchTag("SchemaError", () => Effect.die(new Error(`Invalid field in CSV: ${row._field}`)))
    );
    result[field] = parseFloat(row._value);
  }

  return result;
});

export const SunGatherInfluxDbDataAdapterLayer = Layer.effect(
  DataAdapter,
  Effect.gen(function* () {
    const influxUrl = yield* AppConfig.influx.url;
    const influxToken = yield* AppConfig.influx.token;
    const org = yield* AppConfig.influx.org;
    const bucket = yield* AppConfig.influx.bucket;
    const httpClient = yield* HttpClient.HttpClient;

    const queryLatestValues = Effect.fn("queryLatestValues")(
      function* <F extends Field>(fields: F[]) {
        const url = `${influxUrl}/api/v2/query?org=${org}&pretty=true`;

        const filterExpression = fields
          .map((field) => fieldMap[field] ?? field)
          .map((field) => `r._field == "${field}"`)
          .join(" or ");

        const body = `
      from(bucket: "${bucket}")
            |> range(start: -1h)
            |> filter(fn: (r) => ${filterExpression})
            |> last()
    `;

        const response = yield* httpClient.post(url, {
          headers: {
            "Content-Type": "application/vnd.flux",
            Accept: "application/csv",
            Authorization: `Token ${Redacted.value(influxToken)}`
          },
          body: HttpBody.raw(body)
        });

        const lines = (yield* response.text).trim().split("\n");

        if (lines.length < 2) {
          yield* Effect.logWarning("No data found in latest value query");
          return yield* new DataNotAvailableError();
        }

        const result = yield* parseCsv(lines, fields);

        const mappedResult: Record<string, number> = {};
        for (const field of fields) {
          const mappedField = fieldMap[field] ?? field;
          if (!(mappedField in result)) {
            yield* Effect.logError(`No data found for field ${field}`);
            return yield* new DataNotAvailableError();
          }
          mappedResult[field] = result[mappedField];
        }

        if (!isFieldRecord(mappedResult, fields)) {
          return yield* Effect.die(new Error("Failed to build mapped result"));
        }

        return mappedResult;
      },
      Effect.timeout(Duration.millis(TIMEOUT_MS)),
      Effect.retry({ times: 2, while: (err) => err._tag === "TimeoutError" }),
      Effect.catchTag("TimeoutError", () => Effect.fail(new SourceNotAvailableError())),
      Effect.catchTag("HttpClientError", () => Effect.fail(new SourceNotAvailableError()))
    );

    const getLowestValueInLastXMinutes = Effect.fn("getLowestValueInLastXMinutes")(
      function* (field: Field, minutes: number) {
        const mappedField = fieldMap[field] ?? field;

        const response = yield* httpClient.post(`${influxUrl}/api/v2/query?org=${org}&pretty=true`, {
          headers: {
            "Content-Type": "application/vnd.flux",
            Accept: "application/csv",
            Authorization: `Token ${Redacted.value(influxToken)}`
          },
          body: HttpBody.raw(`
              from(bucket: "${bucket}")
                |> range(start: -${minutes}m)
                |> filter(fn: (r) => r._field == "${mappedField}")
                |> min()
            `)
        });

        const lines = (yield* response.text).trim().split("\n");

        if (lines.length < 2) {
          yield* Effect.logWarning("No data found in last x minutes");
          return yield* new DataNotAvailableError();
        }

        const result = yield* parseCsv(lines, [field]);

        if (!(mappedField in result)) {
          return yield* new DataNotAvailableError();
        }

        return result[mappedField];
      },
      Effect.timeout(Duration.millis(TIMEOUT_MS)),
      Effect.retry({ times: 2, while: (err) => err._tag === "TimeoutError" }),
      Effect.catchTag("TimeoutError", () => Effect.fail(new SourceNotAvailableError())),
      Effect.catchTag("HttpClientError", () => Effect.fail(new SourceNotAvailableError()))
    );

    return DataAdapter.of({
      queryLatestValues,
      getLowestValueInLastXMinutes
    });
  }).pipe(Effect.withSpan("SunGatherInfluxDbDataAdapterLayer"))
);
