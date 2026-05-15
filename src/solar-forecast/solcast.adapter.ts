import { Effect, Layer, Redacted, Schema } from "effect";
import type { Redacted as RedactedType } from "effect/Redacted";
import { HttpClient } from "@effect/platform";
import { FileSystem } from "@effect/platform";
import { SolarForecast, SolarForecastNotAvailableError, type SolarForecastResult } from "./types.js";

// Schema for Solcast API response
const SolarForecastPeriodSchema = Schema.Struct({
  pv_estimate: Schema.Number,
  pv_estimate10: Schema.Number,
  pv_estimate90: Schema.Number,
  period_end: Schema.String,
  period: Schema.String
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
      let memoryCache: {
        data: SolarForecastResult;
        fetchedAt: number;
      } | null = null;
      let rateLimitedToday = false;

      const httpClient = yield* HttpClient.HttpClient;
      const fileSystem = yield* FileSystem.FileSystem;

      const fetchFromApi = Effect.fn("fetchFromApi")(
        function* () {
          if (rateLimitedToday) {
            const fileCache = yield* loadFromFileCache();
            if (fileCache) {
              memoryCache = {
                data: fileCache,
                fetchedAt: Date.now()
              };
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
            rateLimitedToday = true;
            const fileCache = yield* loadFromFileCache();
            if (fileCache) {
              memoryCache = {
                data: fileCache,
                fetchedAt: Date.now()
              };
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
          const parsed = yield* Schema.decodeUnknown(Schema.parseJson(SolcastResponseSchema))(responseText);

          const result: SolarForecastResult = {
            periods: parsed.forecasts
          };

          memoryCache = {
            data: result,
            fetchedAt: Date.now()
          };

          const fileCache: FileCache = {
            fetchedAt: new Date().toISOString(),
            forecasts: parsed.forecasts
          };
          yield* fileSystem.writeFileString(CACHE_FILE_PATH, JSON.stringify(fileCache));

          return result;
        },
        (effect) =>
          effect.pipe(
            Effect.catchAll((error) =>
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
          const cache = yield* Schema.decodeUnknown(Schema.parseJson(FileCacheSchema))(content);

          const fetchedAt = new Date(cache.fetchedAt).getTime();
          const ageMs = Date.now() - fetchedAt;
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
            Effect.catchAll((error) =>
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
          if (memoryCache && Date.now() - memoryCache.fetchedAt < MEMORY_CACHE_TTL_MS) {
            return memoryCache.data;
          }

          const fileCache = yield* loadFromFileCache();
          if (fileCache) {
            const cacheContent = yield* fileSystem.readFileString(CACHE_FILE_PATH);
            const cache = yield* Schema.decodeUnknown(Schema.parseJson(FileCacheSchema))(cacheContent);
            const fetchedAt = new Date(cache.fetchedAt).getTime();
            const ageMs = Date.now() - fetchedAt;

            if (ageMs < MEMORY_CACHE_TTL_MS) {
              memoryCache = {
                data: fileCache,
                fetchedAt: Date.now()
              };
              return fileCache;
            }

            if (ageMs < MAX_CACHE_AGE_DAYS * 24 * 60 * 60 * 1000) {
              const apiResult = yield* fetchFromApi().pipe(
                Effect.catchAll((error) =>
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
            Effect.catchAll((error) => {
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
