import { Effect, Layer, Schema } from "effect";
import { HttpClient } from "@effect/platform";
import { FileSystem } from "@effect/platform";
import {
  SolarForecast,
  SolarForecastNotAvailableError,
  type SolarForecastResult,
} from "./types.js";

// Schema for Solcast API response
const SolarForecastPeriodSchema = Schema.Struct({
  pv_estimate: Schema.Number,
  pv_estimate10: Schema.Number,
  pv_estimate90: Schema.Number,
  period_end: Schema.String,
  period: Schema.String,
});

const SolcastResponseSchema = Schema.Struct({
  forecasts: Schema.Array(SolarForecastPeriodSchema),
});

// File cache schema
const FileCacheSchema = Schema.Struct({
  fetchedAt: Schema.String,
  forecasts: Schema.Array(SolarForecastPeriodSchema),
});

type FileCache = Schema.Schema.Type<typeof FileCacheSchema>;

const CACHE_FILE_PATH = ".solcast-cache.json";
const MEMORY_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes
const MAX_CACHE_AGE_DAYS = 2;

export type SolcastConfig = {
  readonly apiKey: string;
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

      const fetchFromApi = (): Effect.Effect<
        SolarForecastResult,
        SolarForecastNotAvailableError
      > =>
        Effect.gen(function* () {
          if (rateLimitedToday) {
            // If rate-limited, check if we have a valid cache first
            const fileCache = yield* loadFromFileCache();
            if (fileCache) {
              // Update memory cache with file cache
              memoryCache = {
                data: fileCache,
                fetchedAt: Date.now(),
              };
              return fileCache;
            }
            // No valid cache available, fail
            return yield* Effect.fail(
              new SolarForecastNotAvailableError({
                message: "Rate limited for today and no valid cache available",
              })
            );
          }

          const url = new URL(
            `https://api.solcast.com.au/rooftop_sites/${config.rooftopResourceId}/forecasts`
          );
          url.searchParams.set("format", "json");

          const response = yield* httpClient.get(url.toString(), {
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
            },
          });

          if (response.status === 429) {
            rateLimitedToday = true;
            // Check if we have a valid cache before failing
            const fileCache = yield* loadFromFileCache();
            if (fileCache) {
              // Update memory cache with file cache
              memoryCache = {
                data: fileCache,
                fetchedAt: Date.now(),
              };
              return fileCache;
            }
            // No valid cache available, fail
            return yield* Effect.fail(
              new SolarForecastNotAvailableError({
                message: "Rate limited (429) and no valid cache available",
              })
            );
          }

          const responseText = yield* response.text;

          if (response.status !== 200) {
            return yield* Effect.fail(
              new SolarForecastNotAvailableError({
                message: `API returned status ${response.status}. Body: ${responseText}`,
              })
            );
          }
          const parsed = yield* Schema.decodeUnknown(SolcastResponseSchema)(
            JSON.parse(responseText)
          );

          const result: SolarForecastResult = {
            periods: parsed.forecasts,
          };

          // Update memory cache
          memoryCache = {
            data: result,
            fetchedAt: Date.now(),
          };

          // Update file cache
          const fileCache: FileCache = {
            fetchedAt: new Date().toISOString(),
            forecasts: parsed.forecasts,
          };
          yield* fileSystem.writeFileString(
            CACHE_FILE_PATH,
            JSON.stringify(fileCache)
          );

          return result;
        }).pipe(
          Effect.catchAll((error) =>
            error instanceof SolarForecastNotAvailableError
              ? Effect.fail(error)
              : Effect.fail(
                  new SolarForecastNotAvailableError({
                    message: `Failed to fetch forecast: ${error instanceof Error ? error.message : String(error)}`,
                    cause: error,
                  })
                )
          )
        );

      const loadFromFileCache = (): Effect.Effect<
        SolarForecastResult | null,
        never
      > =>
        Effect.gen(function* () {
          const exists = yield* fileSystem.exists(CACHE_FILE_PATH);
          if (!exists) {
            return null;
          }

          const content = yield* fileSystem.readFileString(CACHE_FILE_PATH);
          const cache = yield* Schema.decodeUnknown(FileCacheSchema)(
            JSON.parse(content)
          );

          const fetchedAt = new Date(cache.fetchedAt).getTime();
          const ageMs = Date.now() - fetchedAt;
          const ageDays = ageMs / (24 * 60 * 60 * 1000);

          if (ageDays >= MAX_CACHE_AGE_DAYS) {
            return null; // Cache too old
          }

          return {
            periods: cache.forecasts,
          };
        }).pipe(
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              yield* Effect.logDebug(
                `File cache read failed: ${error instanceof Error ? error.message : String(error)}`
              );
              return null;
            })
          )
        );

      const getForecast = (): Effect.Effect<
        SolarForecastResult,
        SolarForecastNotAvailableError
      > =>
        Effect.gen(function* () {
          // Check memory cache first
          if (
            memoryCache &&
            Date.now() - memoryCache.fetchedAt < MEMORY_CACHE_TTL_MS
          ) {
            return memoryCache.data;
          }

          // Check file cache
          const fileCache = yield* loadFromFileCache();
          if (fileCache) {
            const cacheContent = yield* fileSystem.readFileString(
              CACHE_FILE_PATH
            );
            const cache = yield* Schema.decodeUnknown(FileCacheSchema)(
              JSON.parse(cacheContent)
            );
            const fetchedAt = new Date(cache.fetchedAt).getTime();
            const ageMs = Date.now() - fetchedAt;

            // If file cache is < 60 min old, use it directly
            if (ageMs < MEMORY_CACHE_TTL_MS) {
              memoryCache = {
                data: fileCache,
                fetchedAt: Date.now(),
              };
              return fileCache;
            }

            // If file cache is >= 60 min but from today/yesterday, try API first
            if (ageMs < MAX_CACHE_AGE_DAYS * 24 * 60 * 60 * 1000) {
              const apiResult = yield* fetchFromApi().pipe(
                Effect.catchAll((error) =>
                  Effect.gen(function* () {
                    yield* Effect.logWarning(
                      `API fetch failed, using stale file cache: ${error.message}`
                    );
                    return fileCache;
                  })
                )
              );
              return apiResult;
            }
          }

          // No valid cache, must fetch from API
          const result = yield* fetchFromApi();
          return result;
        }        ).pipe(
          Effect.catchAll((error) => {
            // If API fails, try to use file cache as fallback
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
                          message:
                            "Unable to fetch forecast and no valid cache available",
                          cause: error,
                        })
                      )
                )
              );
            });
          })
        );

      return SolarForecast.of({
        getForecast,
      });
    })
  );
