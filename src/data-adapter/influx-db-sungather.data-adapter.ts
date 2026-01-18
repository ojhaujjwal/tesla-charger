import { Duration, Effect, Layer, Schema } from "effect";
import { HttpClient } from "@effect/platform"
import { type IDataAdapter, type Field, DataNotAvailableError, SourceNotAvailableError, DataAdapter } from "./types.js";
import { raw } from "@effect/platform/HttpBody";
import { AppConfig } from "../config.js";

export const InfluxFieldSchema = Schema.Union(
  Schema.Literal("phase_a_voltage"),
  Schema.Literal("total_active_power"),
  Schema.Literal("load_power"),
  Schema.Literal("daily_import_from_grid"),
  Schema.Literal("export_to_grid"),
  Schema.Literal("import_from_grid")
);

export type InfluxField = Schema.Schema.Type<typeof InfluxFieldSchema>;

const fieldMap: Record<Field, InfluxField> = {
  voltage: 'phase_a_voltage',
  current_production: 'total_active_power',
  current_load: 'load_power',
  daily_import: 'daily_import_from_grid',
  export_to_grid: 'export_to_grid',
  import_from_grid: 'import_from_grid',
}

const parseCsv = <F extends Field>(
  rows: string[],
  fields: readonly F[],
): Effect.Effect<Record<InfluxField, number>, DataNotAvailableError> => Effect.gen(function* () {
  if (rows.length === 0 || rows.length < 2) {
    yield* Effect.logError('No data rows found in CSV');
    return yield* Effect.fail(new DataNotAvailableError());
  }

  const headers = rows[0].split(',');
  const data = rows.slice(1, 1 + fields.length).map(row => {
    const values = row.split(',');
    return headers.reduce((acc, header, index) => {
      acc[header] = values[index];
      return acc;
    }, {} as Record<string, string>);
  });

  const result = {} as Record<InfluxField, number>;

  for (const row of data) {
    const field = yield* Schema.decodeUnknown(InfluxFieldSchema)(row._field).pipe(
      Effect.catchTag('ParseError', () => Effect.dieMessage(`Invalid field in CSV: ${row._field}`))
    );
    result[field as InfluxField] = parseFloat(row._value);
  }

  return result;
});

export class SunGatherInfluxDbDataAdapter implements IDataAdapter {
  private readonly TIMEOUT_MS = 10_000;

  constructor(
    private influxUrl: string,
    private influxToken: string,
    private org: string,
    private bucket: string,
    private httpClient: HttpClient.HttpClient,
  ) {
    Effect.runSync(Effect.logInfo(`Initializing InfluxDB Adapter for bucket: ${bucket}`));
  }

  async authenticate() {
    Effect.runSync(Effect.logInfo('Authenticating with InfluxDB'));
    return null;
  }

  public queryLatestValues<F extends Field>(fields: F[]): Effect.Effect<Record<F, number>, DataNotAvailableError | SourceNotAvailableError> {
    const url = `${this.influxUrl}/api/v2/query?org=${this.org}&pretty=true`;
    const influxToken = this.influxToken;

    const filterExpression = fields
      .map(field => fieldMap[field] ?? field)
      .map(field => `r._field == "${field}"`).join(' or ');

    const body = `
      from(bucket: "${this.bucket}")
            |> range(start: -1h)
            |> filter(fn: (r) => ${filterExpression})
            |> last()
    `;

    const client = this.httpClient;

    return Effect.gen(function* () {

      const response = yield* client.post(
        url,
        {
          headers: {
            'Content-Type': 'application/vnd.flux',
            'Accept': 'application/csv',
            'Authorization': `Token ${influxToken}`
          },
          body: raw(body),
        }
      );

      const lines = (yield* response.text).trim().split('\n');

      if (lines.length < 2) {
        yield* Effect.logWarning('No data found in latest value query');
        return yield* Effect.fail(new DataNotAvailableError())
      }

      const result = yield* parseCsv(lines, fields);

      const mappedResult = {} as Record<Field, number>;
      for (const field of fields) {
        const mappedField = fieldMap[field] ?? field;
        if (!(mappedField in result)) {
          yield* Effect.logError(`No data found for field ${field}`);
          return yield* Effect.fail(new DataNotAvailableError());
        }
        mappedResult[field] = result[mappedField];
      }
      return mappedResult;
    }).pipe(
      Effect.timeout(Duration.millis(this.TIMEOUT_MS)),
      Effect.retry({ times: 2, while: (err) => err._tag === 'TimeoutException' }),
      Effect.catchTag('TimeoutException', () => Effect.fail(new SourceNotAvailableError())),
      Effect.catchTag('RequestError', () => Effect.fail(new SourceNotAvailableError())),
      Effect.catchTag('ResponseError', () => Effect.fail(new SourceNotAvailableError())),
    );
  }

  getLowestValueInLastXMinutes(field: Field, minutes: number) {
    const mappedField = fieldMap[field] ?? field;

    const deps = this;
    const client = this.httpClient;

    return Effect.gen(function* () {
      const response = yield* client.post(
        `${deps.influxUrl}/api/v2/query?org=${deps.org}&pretty=true`,
        {
          headers: {
            'Content-Type': 'application/vnd.flux',
            'Accept': 'application/csv',
            'Authorization': `Token ${deps.influxToken}`
          },
          body: raw(`
              from(bucket: "${deps.bucket}")
                |> range(start: -${minutes}m)
                |> filter(fn: (r) => r._field == "${mappedField}")
                |> min()
            `),
        }
      );

      const lines = (yield* response.text).trim().split('\n');

      if (lines.length < 2) {
        yield* Effect.logWarning('No data found in last x minutes');
        return yield* Effect.fail(new DataNotAvailableError())
      }

      const result = yield* parseCsv(lines, [field]);

      if (!(mappedField in result)) {
        return yield* Effect.fail(new DataNotAvailableError());
      }

      return result[mappedField];
    }).pipe(
      Effect.timeout(Duration.millis(this.TIMEOUT_MS)),
      Effect.retry({ times: 2, while: (err) => err._tag === 'TimeoutException' }),
      Effect.catchTag('TimeoutException', () => Effect.fail(new SourceNotAvailableError())),
      Effect.catchTag('RequestError', () => Effect.fail(new SourceNotAvailableError())),
      Effect.catchTag('ResponseError', () => Effect.fail(new SourceNotAvailableError())),
    );
  }
}

export const SunGatherInfluxDbDataAdapterLayer = Layer.effect(
  DataAdapter,
  Effect.gen(function* () {
    return new SunGatherInfluxDbDataAdapter(
      yield* AppConfig.influx.url,
      yield* AppConfig.influx.token,
      yield* AppConfig.influx.org,
      yield* AppConfig.influx.bucket,
      yield* HttpClient.HttpClient
    );
  })
);
