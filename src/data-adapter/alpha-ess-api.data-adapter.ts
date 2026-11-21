import { Array, Clock, Duration, Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { Digest } from "effect/crypto";
import { Headers, HttpClient } from "effect/http";
import { AppConfig } from "./../config.js";
import { Voltage } from "../domain/brands.js";
import { DataAdapter, DataNotAvailableError, SourceNotAvailableError, type Field } from "./types.js";

const TIMEOUT_MS = 5_000;

const REDACTED_HEADER_NAMES: ReadonlyArray<string | RegExp> = [/^app.?id$/i, /^sign$/i];

function isFieldRecord<F extends string>(obj: Record<string, number>, fields: readonly F[]): obj is Record<F, number> {
  return fields.every((field) => field in obj && typeof obj[field] === "number");
}

const PpvDetailSchema = Schema.Struct({
  ppv1: Schema.Number,
  ppv2: Schema.NullOr(Schema.Number),
  ppv3: Schema.NullOr(Schema.Number),
  ppv4: Schema.NullOr(Schema.Number),
  pmeterDc: Schema.Number
});

const PevDetailSchema = Schema.Struct({
  ev1Power: Schema.NullOr(Schema.Number),
  ev2Power: Schema.NullOr(Schema.Number),
  ev3Power: Schema.NullOr(Schema.Number),
  ev4Power: Schema.NullOr(Schema.Number)
});

const PgridDetailSchema = Schema.Struct({
  pmeterL1: Schema.Number,
  pmeterL2: Schema.Number,
  pmeterL3: Schema.Number
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
  pgridDetail: PgridDetailSchema
}).pipe(Schema.NullOr);

const ApiResponseSchema = Schema.Struct({
  code: Schema.Number,
  msg: Schema.String,
  expMsg: Schema.NullOr(Schema.String),
  data: PowerDataSchema,
  extra: Schema.NullOr(Schema.Unknown)
});

export type ApiResponse = Schema.Schema.Type<typeof ApiResponseSchema>;

const mapFieldToValue = (field: Field, data: NonNullable<ApiResponse["data"]>): number => {
  switch (field) {
    case "voltage":
      // Hardcoded value for voltage as API does not provide it
      return Voltage(235);

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

    case "battery_power":
      // Battery power: negative = charging, positive = discharging
      return data.pbat;
  }
};

export const AlphaEssCloudApiDataAdapterLayer = Layer.effect(
  DataAdapter,
  Effect.gen(function* () {
    const config = AppConfig.alphaEssAPI;
    const appId = yield* config.appId;
    const appSecret = yield* config.appSecret;
    const sysSn = yield* config.sysSn;
    const baseUrl = yield* config.baseUrl;

    const digest = yield* Digest.Digest;
    const httpClient = HttpClient.transform(yield* HttpClient.HttpClient, (effect) =>
      effect.pipe(
        Effect.provideService(HttpClient.TracerHeaderFilter, () => true),
        Effect.updateService(Headers.CurrentRedactedNames, (names) => Array.appendAll(names, REDACTED_HEADER_NAMES))
      )
    );

    // Alpha ESS signs the request headers as sha512(appId + appSecret + timeStamp), lowercase hex.
    const generateSignature = Effect.fn("generateSignature")(function* (timestamp: string) {
      const input = `${Redacted.value(appId)}${Redacted.value(appSecret)}${timestamp}`;
      return yield* digest.digestHex(Digest.sha512, new TextEncoder().encode(input));
    });

    const queryLatestValues = Effect.fn("queryLatestValues")(
      function* <F extends Field>(fields: F[]) {
        const timestamp = Math.floor((yield* Clock.currentTimeMillis) / 1000).toString();
        const signature = yield* generateSignature(timestamp);

        const url = `${baseUrl}/api/getLastPowerData?sysSn=${sysSn}`;
        const headers = {
          appId: Redacted.value(appId),
          timeStamp: timestamp,
          sign: signature,
          "Content-Type": "application/json"
        };

        const response = yield* httpClient.get(url, { headers });
        const responseBody = yield* response.json;

        yield* Effect.logDebug("Alpha ESS API Response:", responseBody);

        const parsed = yield* Schema.decodeUnknownEffect(ApiResponseSchema)(responseBody).pipe(
          Effect.catchTag("SchemaError", () => Effect.die(new Error(`Unrecognized response from Alpha ESS API`)))
        );

        if (parsed.code !== 200 || !parsed.data) {
          return yield* new DataNotAvailableError();
        }

        const result: Record<string, number> = {};
        for (const field of fields) {
          result[field] = mapFieldToValue(field, parsed.data);
        }

        if (!isFieldRecord(result, fields)) {
          return yield* Effect.die(new Error("Failed to build result record"));
        }

        return result;
      },
      Effect.timeout(Duration.millis(TIMEOUT_MS)),
      Effect.retry({
        schedule: Schedule.exponential(Duration.seconds(2), 2).pipe(Schedule.upTo({ times: 6 })),
        while: (err: { readonly _tag: string; readonly reason?: { readonly _tag: string } }) =>
          err._tag === "TimeoutError" || (err._tag === "HttpClientError" && err.reason?._tag === "TransportError")
      }),
      Effect.catchTag("TimeoutError", () => Effect.fail(new SourceNotAvailableError())),
      Effect.catchTag("HttpClientError", () => Effect.fail(new SourceNotAvailableError()))
    );

    return DataAdapter.of({
      queryLatestValues,
      getLowestValueInLastXMinutes: Effect.fn("getLowestValueInLastXMinutes")(function* () {
        return yield* new DataNotAvailableError();
      })
    });
  }).pipe(Effect.withSpan("AlphaEssCloudApiDataAdapterLayer"))
).pipe(Layer.provide(Digest.layerWebCrypto));
