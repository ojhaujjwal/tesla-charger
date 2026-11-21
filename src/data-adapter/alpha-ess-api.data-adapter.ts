import { Array, Clock, DateTime, Duration, Effect, Layer, Redacted, Schedule, Schema } from "effect";
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

const HistoricalSampleSchema = Schema.Struct({
  sysSn: Schema.String,
  uploadTime: Schema.String,
  ppv: Schema.Number,
  load: Schema.Number,
  cbat: Schema.Number,
  feedIn: Schema.Number,
  gridCharge: Schema.Number,
  pchargingPile: Schema.Number
});

type HistoricalSampleValueField = "ppv" | "load" | "feedIn" | "gridCharge";

const HistoricalResponseSchema = Schema.Struct({
  code: Schema.Number,
  msg: Schema.String,
  expMsg: Schema.NullOr(Schema.String),
  data: Schema.NullOr(Schema.Array(HistoricalSampleSchema)),
  extra: Schema.NullOr(Schema.Unknown)
});

// The power history exposes separate export/import columns instead of the signed
// pgrid of getLastPowerData, and has no voltage or battery power.
const historicalFieldMap: Partial<Record<Field, HistoricalSampleValueField>> = {
  current_production: "ppv",
  current_load: "load",
  export_to_grid: "feedIn",
  import_from_grid: "gridCharge"
};

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

    const fetchSigned = Effect.fn("fetchSigned")(function* (path: string, query: Record<string, string>) {
      const timestamp = Math.floor((yield* Clock.currentTimeMillis) / 1000).toString();
      const signature = yield* generateSignature(timestamp);
      const queryString = new URLSearchParams(query).toString();

      const headers = {
        appId: Redacted.value(appId),
        timeStamp: timestamp,
        sign: signature,
        "Content-Type": "application/json"
      };

      const response = yield* httpClient.get(`${baseUrl}/api/${path}?${queryString}`, { headers });
      return yield* response.json;
    });

    const queryLatestValues = Effect.fn("queryLatestValues")(
      function* <F extends Field>(fields: F[]) {
        const responseBody = yield* fetchSigned("getLastPowerData", { sysSn });

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

    const queryOneDayPower = Effect.fn("queryOneDayPower")(function* (queryDate: string) {
      const responseBody = yield* fetchSigned("getOneDayPowerBySn", { sysSn, queryDate });

      const parsed = yield* Schema.decodeUnknownEffect(HistoricalResponseSchema)(responseBody).pipe(
        Effect.catchTag("SchemaError", () => Effect.die(new Error(`Unrecognized response from Alpha ESS API`)))
      );

      if (parsed.code !== 200 || !parsed.data) {
        return yield* new DataNotAvailableError();
      }

      return parsed.data;
    });

    const getLowestValueInLastXMinutes = Effect.fn("getLowestValueInLastXMinutes")(
      function* (field: Field, minutes: number) {
        const valueField = historicalFieldMap[field];
        if (!valueField) {
          return yield* new DataNotAvailableError();
        }

        const zone = DateTime.zoneMakeLocal();
        const now = DateTime.setZone(yield* DateTime.now, zone);
        const nowMs = DateTime.toEpochMillis(now);
        const cutoffMs = nowMs - minutes * 60_000;

        const dates: string[] = [];
        for (
          let cursor = DateTime.makeUnsafe(cutoffMs);
          DateTime.toEpochMillis(cursor) <= nowMs;
          cursor = DateTime.add(cursor, { days: 1 })
        ) {
          const date = DateTime.formatIsoDate(DateTime.setZone(cursor, zone));
          if (!dates.includes(date)) {
            dates.push(date);
          }
        }

        const today = DateTime.formatIsoDate(now);
        if (!dates.includes(today)) {
          dates.push(today);
        }

        const samples = yield* Effect.forEach(dates, queryOneDayPower, { concurrency: 1 });

        let lowest: number | undefined;
        for (const sample of samples.flat()) {
          // getOneDayPowerBySn reports uploadTime as a zone-less wall clock.
          const uploadedAt = DateTime.makeZonedUnsafe(sample.uploadTime, {
            timeZone: zone,
            adjustForTimeZone: true
          });
          if (DateTime.toEpochMillis(uploadedAt) < cutoffMs) continue;

          const value = sample[valueField];
          lowest = lowest === undefined ? value : Math.min(lowest, value);
        }

        if (lowest === undefined) {
          return yield* new DataNotAvailableError();
        }

        return lowest;
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
      getLowestValueInLastXMinutes
    });
  }).pipe(Effect.withSpan("AlphaEssCloudApiDataAdapterLayer"))
).pipe(Layer.provide(Digest.layerWebCrypto));
