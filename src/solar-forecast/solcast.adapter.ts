import {
  Clock,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
  SchemaIssue
} from "effect";
import * as SchemaGetter from "effect/SchemaGetter";
import type { Redacted as RedactedType } from "effect/Redacted";
import { HttpClient } from "effect/http";
import { SolarForecast, SolarForecastNotAvailableError, type SolarForecastResult } from "./types.js";

// Schema for Solcast API response
// `period` arrives as an ISO 8601 duration (e.g. "PT30M"); Duration.fromInput
// only accepts "<number> <unit>" strings, so parse the ISO form ourselves.
const parseIsoDuration = (iso: string): Option.Option<Duration.Duration> => {
  const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso);
  if (!match) return Option.none();
  const hours = match[1];
  const minutes = match[2];
  const seconds = match[3];
  if (hours) return Option.some(Duration.hours(Number(hours)));
  if (minutes) return Option.some(Duration.minutes(Number(minutes)));
  if (seconds) return Option.some(Duration.seconds(Number(seconds)));
  return Option.none();
};

const SolarForecastPeriodSchema = Schema.Struct({
  pv_estimate: Schema.Number,
  pv_estimate10: Schema.Number,
  pv_estimate90: Schema.Number,
  period_end: Schema.DateTimeUtcFromString,
  period: Schema.String.pipe(
    Schema.decodeTo(Schema.Duration, {
      decode: SchemaGetter.transformEffect((iso: string) =>
        Option.match(parseIsoDuration(iso), {
          onNone: () => Effect.fail(new SchemaIssue.InvalidValue({ message: `Invalid ISO 8601 duration: ${iso}` })),
          onSome: (duration) => Effect.succeed(duration)
        })
      ),
      encode: SchemaGetter.transformEffect((duration: Duration.Duration) =>
        Option.match(Duration.formatIso(duration), {
          onNone: () =>
            Effect.fail(new SchemaIssue.InvalidValue({ message: "Cannot encode an infinite duration as ISO 8601" })),
          onSome: (iso) => Effect.succeed(iso)
        })
      )
    })
  )
});

const SolcastResponseSchema = Schema.Struct({
  forecasts: Schema.Array(SolarForecastPeriodSchema)
});

// File cache schema
const FileCacheSchema = Schema.Struct({
  fetchedAt: Schema.String,
  forecasts: Schema.Array(SolarForecastPeriodSchema)
});

type FileCache = Schema.Schema.Type<typeof FileCacheSchema>;

const CACHE_FILE_PATH = ".solcast-cache.json";
const MEMORY_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes
const MAX_CACHE_AGE_DAYS = 2;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const epochDay = (epochMillis: number) => Math.floor(epochMillis / MS_PER_DAY);

type MemoryCache = {
  data: SolarForecastResult;
  fetchedAt: number;
} | null;

export type SolcastConfig = {
  readonly apiKey: RedactedType<string>;
  readonly rooftopResourceId: string;
};

export const SolcastForecastLayer = (
  config: SolcastConfig
): Layer.Layer<SolarForecast, never, HttpClient.HttpClient | FileSystem.FileSystem> =>
  Layer.effect(
    SolarForecast,
    Effect.gen(function* () {
      const memoryCacheRef = yield* Ref.make<MemoryCache>(null);
      const rateLimitedDayRef = yield* Ref.make<number | null>(null);

      const httpClient = yield* HttpClient.HttpClient;
      const fileSystem = yield* FileSystem.FileSystem;

      const fetchFromApi = Effect.fn("fetchFromApi")(
        function* () {
          const rateLimitedDay = yield* Ref.get(rateLimitedDayRef);
          if (rateLimitedDay !== null && rateLimitedDay === epochDay(yield* Clock.currentTimeMillis)) {
            const fileCache = yield* loadFromFileCache();
            if (fileCache) {
              yield* Ref.set(memoryCacheRef, {
                data: fileCache,
                fetchedAt: yield* Clock.currentTimeMillis
              });
              return fileCache;
            }
            return yield* new SolarForecastNotAvailableError({
              message: "Rate limited for today and no valid cache available"
            });
          }

          const url = new URL(`https://api.solcast.com.au/rooftop_sites/${config.rooftopResourceId}/forecasts`);
          url.searchParams.set("format", "json");

          const response = yield* httpClient.get(url.toString(), {
            headers: {
              Authorization: `Bearer ${Redacted.value(config.apiKey)}`
            }
          });

          if (response.status === 429) {
            yield* Ref.set(rateLimitedDayRef, epochDay(yield* Clock.currentTimeMillis));
            const fileCache = yield* loadFromFileCache();
            if (fileCache) {
              yield* Ref.set(memoryCacheRef, {
                data: fileCache,
                fetchedAt: yield* Clock.currentTimeMillis
              });
              return fileCache;
            }
            return yield* new SolarForecastNotAvailableError({
              message: "Rate limited (429) and no valid cache available"
            });
          }

          const responseText = yield* response.text;

          if (response.status !== 200) {
            return yield* new SolarForecastNotAvailableError({
              message: `API returned status ${response.status}. Body: ${responseText}`
            });
          }
          const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SolcastResponseSchema))(responseText);

          const result: SolarForecastResult = {
            periods: parsed.forecasts
          };

          yield* Ref.set(memoryCacheRef, {
            data: result,
            fetchedAt: yield* Clock.currentTimeMillis
          });

          const fileCache: FileCache = {
            fetchedAt: DateTime.formatIso(yield* DateTime.now),
            forecasts: parsed.forecasts
          };
          yield* fileSystem.writeFileString(
            CACHE_FILE_PATH,
            yield* Schema.encodeEffect(Schema.fromJsonString(FileCacheSchema))(fileCache)
          );

          return result;
        },
        (effect) =>
          effect.pipe(
            Effect.catch((error) =>
              error instanceof SolarForecastNotAvailableError
                ? Effect.fail(error)
                : Effect.fail(
                    new SolarForecastNotAvailableError({
                      message: `Failed to fetch forecast: ${error instanceof Error ? error.message : String(error)}`,
                      cause: error
                    })
                  )
            )
          )
      );

      const loadFromFileCache = Effect.fn("loadFromFileCache")(
        function* () {
          const exists = yield* fileSystem.exists(CACHE_FILE_PATH);
          if (!exists) {
            return null;
          }

          const content = yield* fileSystem.readFileString(CACHE_FILE_PATH);
          const cache = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FileCacheSchema))(content);

          const fetchedAt = Option.getOrThrow(DateTime.make(cache.fetchedAt));
          const ageMs = (yield* Clock.currentTimeMillis) - DateTime.toEpochMillis(fetchedAt);
          const ageDays = ageMs / (24 * 60 * 60 * 1000);

          if (ageDays >= MAX_CACHE_AGE_DAYS) {
            return null;
          }

          return {
            periods: cache.forecasts
          };
        },
        (effect) =>
          effect.pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* Effect.logDebug(
                  `File cache read failed: ${error instanceof Error ? error.message : String(error)}`
                );
                return null;
              })
            )
          )
      );

      const getForecast = Effect.fn("getForecast")(
        function* () {
          const memoryCache = yield* Ref.get(memoryCacheRef);
          if (memoryCache && (yield* Clock.currentTimeMillis) - memoryCache.fetchedAt < MEMORY_CACHE_TTL_MS) {
            return memoryCache.data;
          }

          const fileCache = yield* loadFromFileCache();
          if (fileCache) {
            const cacheContent = yield* fileSystem.readFileString(CACHE_FILE_PATH);
            const cache = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FileCacheSchema))(cacheContent);
            const fetchedAt = Option.getOrThrow(DateTime.make(cache.fetchedAt));
            const ageMs = (yield* Clock.currentTimeMillis) - DateTime.toEpochMillis(fetchedAt);

            if (ageMs < MEMORY_CACHE_TTL_MS) {
              yield* Ref.set(memoryCacheRef, {
                data: fileCache,
                fetchedAt: yield* Clock.currentTimeMillis
              });
              return fileCache;
            }

            if (ageMs < MAX_CACHE_AGE_DAYS * 24 * 60 * 60 * 1000) {
              const apiResult = yield* fetchFromApi().pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    yield* Effect.logWarning(`API fetch failed, using stale file cache: ${error.message}`);
                    return fileCache;
                  })
                )
              );
              return apiResult;
            }
          }

          const result = yield* fetchFromApi();
          return result;
        },
        (effect) =>
          effect.pipe(
            Effect.catch((error) => {
              return Effect.gen(function* () {
                yield* Effect.logWarning(
                  `Failed to fetch forecast from API, falling back to file cache: ${error.message}`
                );
                return yield* loadFromFileCache().pipe(
                  Effect.flatMap((fileCache) =>
                    fileCache
                      ? Effect.succeed(fileCache)
                      : Effect.fail(
                          new SolarForecastNotAvailableError({
                            message: "Unable to fetch forecast and no valid cache available",
                            cause: error
                          })
                        )
                  )
                );
              });
            })
          )
      );

      return SolarForecast.of({
        getForecast
      });
    }).pipe(Effect.withSpan("SolcastForecastLayer"))
  );
