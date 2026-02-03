import { Duration, Effect, Layer, Schedule, Schema } from "effect";
import { DataAdapter, DataNotAvailableError, SourceNotAvailableError, type Field, type IDataAdapter } from "./types.js";
import { HttpClient } from "@effect/platform";
import { AppConfig } from "./../config.js";
import { createHash } from "node:crypto";

export type AlphaEssConfig = {
  readonly appId: string;
  readonly appSecret: string;
  readonly sysSn: string;
  readonly baseUrl: string;
}

// ============================================================================
// 2. API Response Schema
// ============================================================================

const PpvDetailSchema = Schema.Struct({
  ppv1: Schema.Number,
  ppv2: Schema.Number,
  ppv3: Schema.Number,
  ppv4: Schema.Number,
  pmeterDc: Schema.Number,
});

const PevDetailSchema = Schema.Struct({
  ev1Power: Schema.NullOr(Schema.Number),
  ev2Power: Schema.NullOr(Schema.Number),
  ev3Power: Schema.NullOr(Schema.Number),
  ev4Power: Schema.NullOr(Schema.Number),
});

const PgridDetailSchema = Schema.Struct({
  pmeterL1: Schema.Number,
  pmeterL2: Schema.Number,
  pmeterL3: Schema.Number,
});

const PowerDataSchema = Schema.Struct({
  ppv: Schema.Number,
  ppvDetail: PpvDetailSchema,
  soc: Schema.Number,
  pev: Schema.Number,
  pevDetail: PevDetailSchema,
  prealL1: Schema.Number,
  prealL2: Schema.Number,
  prealL3: Schema.Number,
  pbat: Schema.Number,
  pgrid: Schema.Number,
  pload: Schema.Number,
  pgridDetail: PgridDetailSchema,
}).pipe(Schema.NullOr);

const ApiResponseSchema = Schema.Struct({
  code: Schema.Number,
  msg: Schema.String,
  expMsg: Schema.NullOr(Schema.String),
  data: PowerDataSchema,
  extra: Schema.NullOr(Schema.Unknown),
});

export type ApiResponse = Schema.Schema.Type<typeof ApiResponseSchema>;


const generateSignature = (
  appId: string,
  appSecret: string,
  timestamp: string
): string => {
  const input = `${appId}${appSecret}${timestamp}`;
  //todo: use Effect Platform
  return createHash("sha512").update(input).digest("hex");
}

const mapFieldToValue = (
  field: Field,
  data: NonNullable<ApiResponse["data"]>
): number => {
  switch (field) {
    case "voltage":
      // Hardcoded value for voltage as API does not provide it
      return 235;

    case "current_production":
      return data.ppv;

    case "current_load":
      return data.pload;

    case "daily_import":
      // Not supported, return zero
      return 0;

    case "export_to_grid":
      // Export to grid is negative pgrid values
      return data.pgrid < 0 ? Math.abs(data.pgrid) : 0;

    case "import_from_grid":
      // Import from grid is positive pgrid values
      return data.pgrid > 0 ? data.pgrid : 0;
  }
};

export class AlphaEssCloudApiDataAdapter implements IDataAdapter {
  private readonly TIMEOUT_MS = 5_000;

  constructor(
    private config: AlphaEssConfig,
    private httpClient: HttpClient.HttpClient,
  ) { }

  public queryLatestValues<F extends Field>(fields: F[]): Effect.Effect<Record<F, number>, DataNotAvailableError | SourceNotAvailableError> {
    const config = this.config;
    const httpClient = this.httpClient;

    return Effect.gen(function* () {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = generateSignature(
        config.appId,
        config.appSecret,
        timestamp
      );

      // Make API request
      const url = `${config.baseUrl}/api/getLastPowerData?sysSn=${config.sysSn}`;
      const headers = {
        "appId": config.appId,
        "timeStamp": timestamp,
        "sign": signature,
        "Content-Type": "application/json",
      };

      const response = yield* httpClient.get(url, { headers });
      const responseBody = yield* response.json;

      yield* Effect.logDebug("Alpha ESS API Response:", responseBody);

      // Parse and validate response
      const parsed = yield* Schema.decodeUnknown(ApiResponseSchema)(responseBody).pipe(
        Effect.catchTag('ParseError', () => Effect.dieMessage(`Unrecognized response from Alpha ESS API`)),
      );

      if (parsed.code !== 200 || !parsed.data) {
        return yield* new DataNotAvailableError();
      }

      // Map fields to values
      const result = {} as Record<F, number>;
      for (const field of fields) {
        result[field] = mapFieldToValue(field, parsed.data);
      }

      return result;
    }).pipe(
      Effect.timeout(Duration.millis(this.TIMEOUT_MS)),
      Effect.retry({
        schedule: Schedule.compose(
          Schedule.recurs(5),  // Max 5 retries (6 total attempts)
          Schedule.exponential(Duration.seconds(2), 2) // Backoff: 2s, 4s, 8s, 16s, 32s
        ),
        while: (err) => err._tag === 'TimeoutException' || (err._tag === "RequestError" && err.reason === "Transport")
      }),
      Effect.catchTag('TimeoutException', () => Effect.fail(new SourceNotAvailableError())),
      Effect.catchTag('RequestError', () => Effect.fail(new SourceNotAvailableError())),
      Effect.catchTag('ResponseError', () => Effect.fail(new SourceNotAvailableError())),
    );
  }


  public getLowestValueInLastXMinutes(): Effect.Effect<number, DataNotAvailableError> {
    return Effect.fail(new DataNotAvailableError());
  };
}

export const AlphaEssCloudApiDataAdapterLayer = Layer.effect(
  DataAdapter,
  Effect.gen(function* () {
    const config = AppConfig.alphaEssAPI;

    return new AlphaEssCloudApiDataAdapter(
      {
        appId: yield* config.appId,
        appSecret: yield* config.appSecret,
        sysSn: yield* config.sysSn,
        baseUrl: yield* config.baseUrl,
      },
      yield* HttpClient.HttpClient
    );
  })
);
