import { Duration, Effect } from "effect";
import { HttpClient } from "@effect/platform"
import { type IDataAdapter, type Field, DataNotAvailableError, SourceNotAvailableError } from "./types.js";
import { raw } from "@effect/platform/HttpBody";

// Enhanced logging utility
const logger = {
  info: (message: string) => console.log(`[InfluxDB Adapter] ${message}`),
  error: (message: string) => console.error(`[InfluxDB Adapter] ERROR: ${message}`),
  warn: (message: string) => console.warn(`[InfluxDB Adapter] WARNING: ${message}`)
};

// Custom error for more detailed error handling
class InfluxDataAdapterError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'InfluxDataAdapterError';
  }
}

type AuthContext = null;

type InfluxField = 'phase_a_voltage'
  | 'total_active_power'
  | 'load_power'
  | 'daily_import_from_grid'
  | 'export_to_grid'
  | 'import_from_grid';

const fieldMap: Record<Field, InfluxField> = {
  voltage: 'phase_a_voltage',
  current_production: 'total_active_power',
  current_load: 'load_power',
  daily_import: 'daily_import_from_grid',
  export_to_grid: 'export_to_grid',
  import_from_grid: 'import_from_grid',
}

const parseCsv = (rows: string[], numberOfRows: number) => {
  if (rows.length === 0) {
    logger.error('No data rows found in CSV');
    throw new InfluxDataAdapterError('No data found', 'NO_DATA');
  }
  
  if (rows.length < 2) { 
    logger.error('No data rows found in CSV');
    throw new InfluxDataAdapterError('No data found', 'NO_DATA');
  }

  const headers = rows[0].split(',');
  const data = rows.slice(1, 1 + numberOfRows).map(row => {
    const values = row.split(',');
    return headers.reduce((acc, header, index) => {
      acc[header] = values[index];
      return acc;
    }, {} as Record<string, string>);
  });

  return data.reduce((acc, row) => {
    acc[row._field] = parseFloat(row._value);
    return acc;
  }, {} as Record<string, number>);
}


export class SunGatherInfluxDbDataAdapter implements IDataAdapter<AuthContext>  {
  private readonly TIMEOUT_MS = 10000; // 10 seconds timeout

  constructor(
    private influxUrl: string,
    private influxToken: string,
    private org: string,
    private bucket: string,
    private httpClient: HttpClient.HttpClient,
  ) {
    logger.info(`Initializing InfluxDB Adapter for bucket: ${bucket}`);
  }

  async authenticate() {
    logger.info('Authenticating with InfluxDB');
    return null;
  }

  private async fetchWithTimeout(url: string, options: RequestInit, timeout = this.TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(id);
      return response;
    } catch (error) {
      clearTimeout(id);
      if (error instanceof Error && error.name === 'AbortError') {
        logger.error('Request timed out');
        throw new InfluxDataAdapterError('Request timed out', 'TIMEOUT');
      }
      throw error;
    }
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
        logger.warn('No data found in latest value query');
        yield* Effect.fail(new DataNotAvailableError)
      }

      const result = parseCsv(lines, fields.length);

      return fields.reduce((acc, field) => {
        const mappedField = fieldMap[field] ?? field;
        if (!(mappedField in result)) {
          // todo: convert throw to Effect.fail
          // return Effect.fail(new DataNotAvailableError())
          throw new InfluxDataAdapterError(`No data found for field ${field}`, 'FIELD_NOT_FOUND');
        }

        acc[field] = result[mappedField];
        return acc;
      }, {} as Record<Field, number>);
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

    return Effect.gen(function*() {
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
        logger.warn('No data found in last x minutes');
        yield* Effect.fail(new DataNotAvailableError)
      }

      //return parseCsv(lines, fields.length) as Record<F, number>;

      const result = parseCsv(lines, 1) as Record<string, number>;

      return result[mappedField] 
        ? result[mappedField]
        : yield* Effect.fail(new DataNotAvailableError);
    }).pipe(
      Effect.timeout(Duration.millis(this.TIMEOUT_MS)),
      Effect.retry({ times: 2, while: (err) => err._tag === 'TimeoutException' }),
      Effect.catchTag('TimeoutException', () => Effect.fail(new SourceNotAvailableError())),
      Effect.catchTag('RequestError', () => Effect.fail(new SourceNotAvailableError())),
      Effect.catchTag('ResponseError', () => Effect.fail(new SourceNotAvailableError())),
    );
  }
}
