import { describe, it, expect, beforeEach, afterEach } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse, FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { SolarForecast, SolarForecastNotAvailableError } from "../../../solar-forecast/types.js";
import { SolcastForecastLayer } from "../../../solar-forecast/solcast.adapter.js";

// Helper to create a mock HttpResponse
const mockResponse = (
  req: HttpClientRequest.HttpClientRequest,
  body: string,
  status = 200
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    req,
    new Response(body, {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );

// Mock HttpClient factory with call tracking
const makeMockHttpClient = (
  responseJson: unknown,
  status = 200,
  callTracker?: { count: number }
): HttpClient.HttpClient =>
  HttpClient.make((req) => {
    if (callTracker) {
      callTracker.count++;
    }
    return Effect.succeed(mockResponse(req, JSON.stringify(responseJson), status));
  });

const CACHE_FILE_PATH = ".solcast-cache.json";

describe("SolcastForecastAdapter", () => {
  const mockConfig = {
    apiKey: "test-api-key",
    rooftopResourceId: "test-rooftop-id",
  };

  const mockSolcastResponse = {
    forecasts: [
      {
        pv_estimate: 2.5,
        pv_estimate10: 2.5,
        pv_estimate90: 2.5,
        period_end: "2026-02-14T10:00:00Z",
        period: "PT30M",
      },
      {
        pv_estimate: 3.0,
        pv_estimate10: 3.0,
        pv_estimate90: 3.0,
        period_end: "2026-02-14T10:30:00Z",
        period: "PT30M",
      },
      {
        pv_estimate: 3.5,
        pv_estimate10: 3.5,
        pv_estimate90: 3.5,
        period_end: "2026-02-14T11:00:00Z",
        period: "PT30M",
      },
    ],
  };

  const differentCacheResponse = {
    forecasts: [
      {
        pv_estimate: 1.0,
        pv_estimate10: 1.0,
        pv_estimate90: 1.0,
        period_end: "2026-02-14T10:00:00Z",
        period: "PT30M",
      },
      {
        pv_estimate: 1.5,
        pv_estimate10: 1.5,
        pv_estimate90: 1.5,
        period_end: "2026-02-14T10:30:00Z",
        period: "PT30M",
      },
      {
        pv_estimate: 2.0,
        pv_estimate10: 2.0,
        pv_estimate90: 2.0,
        period_end: "2026-02-14T11:00:00Z",
        period: "PT30M",
      },
    ],
  };

  const getTestLayer = (httpClient: HttpClient.HttpClient) =>
    SolcastForecastLayer(mockConfig).pipe(
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, httpClient)),
      Layer.provideMerge(NodeFileSystem.layer)
    );

  beforeEach(() => {
    // Clean up cache file before each test
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const exists = yield* fs.exists(CACHE_FILE_PATH);
      if (exists) {
        yield* fs.remove(CACHE_FILE_PATH);
      }
    })
      .pipe(Effect.provide(NodeFileSystem.layer), Effect.runPromise)
      .catch(() => Promise.resolve());
  });

  afterEach(() => {
    // Clean up cache file after each test
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const exists = yield* fs.exists(CACHE_FILE_PATH);
      if (exists) {
        yield* fs.remove(CACHE_FILE_PATH);
      }
    })
      .pipe(Effect.provide(NodeFileSystem.layer), Effect.runPromise)
      .catch(() => Promise.resolve());
  });

  describe("getForecast", () => {
    it.effect("should return forecast periods from API on first call", () => {
      const callTracker = { count: 0 };
      return Effect.gen(function* () {
        const forecast = yield* SolarForecast;
        const result = yield* forecast.getForecast();

        expect(result.periods).toHaveLength(3);
        expect(result.periods[0]).toEqual({
          pv_estimate: 2.5,
          pv_estimate10: 2.5,
          pv_estimate90: 2.5,
          period_end: "2026-02-14T10:00:00Z",
          period: "PT30M",
        });
        // API should have been called
        expect(callTracker.count).toBe(1);
      }).pipe(
        Effect.provide(
          getTestLayer(makeMockHttpClient(mockSolcastResponse, 200, callTracker))
        )
      );
    });

    it.effect(
      "should return cached forecast from memory when age < 60 minutes",
      () => {
        const callTracker = { count: 0 };
        return Effect.gen(function* () {
          const forecast = yield* SolarForecast;
          const result1 = yield* forecast.getForecast();
          const result2 = yield* forecast.getForecast();

          // Both should return the same data (from memory cache)
          expect(result1.periods).toEqual(result2.periods);
          // HTTP client should only be called once (first call), second call uses cache
          expect(callTracker.count).toBe(1);
        }).pipe(
          Effect.provide(
            getTestLayer(
              makeMockHttpClient(mockSolcastResponse, 200, callTracker)
            )
          )
        );
      }
    );

    it.effect(
      "should return file cache on startup if age < 60 minutes and not call API",
      () => {
        const fileCacheContent = JSON.stringify({
          fetchedAt: new Date().toISOString(), // Fresh cache
          forecasts: differentCacheResponse.forecasts, // Different from API to prove cache is used
        });

        const callTracker = { count: 0 };
        return Effect.gen(function* () {
          // Write cache file first
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(CACHE_FILE_PATH, fileCacheContent);

          const forecast = yield* SolarForecast;
          const result = yield* forecast.getForecast();

          // Should return cached data (different from API)
          expect(result.periods).toHaveLength(3);
          expect(result.periods[0].pv_estimate).toBe(1.0); // Cache value, not API value
          // API should NOT have been called
          expect(callTracker.count).toBe(0);
        }).pipe(
          Effect.provide(
            getTestLayer(makeMockHttpClient(mockSolcastResponse, 200, callTracker)).pipe(
              Layer.provideMerge(NodeFileSystem.layer)
            )
          )
        );
      }
    );

    it.effect(
      "should fall back to file cache if API returns 429 rate limit",
      () => {
        const fileCacheContent = JSON.stringify({
          fetchedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(), // 90 min ago (stale memory cache, valid file cache)
          forecasts: differentCacheResponse.forecasts, // Different from API to prove cache is used
        });

        const callTracker = { count: 0 };
        return Effect.gen(function* () {
          // Write cache file first
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(CACHE_FILE_PATH, fileCacheContent);

          const forecast = yield* SolarForecast;
          const result = yield* forecast.getForecast();

          // Should return cached data (different from API)
          expect(result.periods).toHaveLength(3);
          expect(result.periods[0].pv_estimate).toBe(1.0); // Cache value, not API value
          // API should have been called (attempted) but failed with 429
          expect(callTracker.count).toBe(1);
        }).pipe(
          Effect.provide(
            getTestLayer(makeMockHttpClient(mockSolcastResponse, 429, callTracker)).pipe(
              Layer.provideMerge(NodeFileSystem.layer)
            )
          )
        );
      }
    );

    it.effect(
      "should fetch from API if file cache is >= 2 days old and use API data",
      () => {
        const oldFileCacheContent = JSON.stringify({
          fetchedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
          forecasts: differentCacheResponse.forecasts, // Different from API to prove API is used
        });

        const callTracker = { count: 0 };
        return Effect.gen(function* () {
          // Write old cache file first
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(CACHE_FILE_PATH, oldFileCacheContent);

          const forecast = yield* SolarForecast;
          const result = yield* forecast.getForecast();

          // Should fetch fresh data from API (not use old cache)
          expect(result.periods).toHaveLength(3);
          expect(result.periods[0].pv_estimate).toBe(2.5); // API value, not cache value (1.0)
          // API should have been called to fetch fresh data
          expect(callTracker.count).toBe(1);
        }).pipe(
          Effect.provide(
            getTestLayer(makeMockHttpClient(mockSolcastResponse, 200, callTracker)).pipe(
              Layer.provideMerge(NodeFileSystem.layer)
            )
          )
        );
      }
    );

    it.effect(
      "should return SolarForecastNotAvailableError if API fails and no valid cache exists",
      () => {
        const callTracker = { count: 0 };
        return Effect.gen(function* () {
          const forecast = yield* SolarForecast;
          const result = yield* Effect.exit(forecast.getForecast());

          expect(result).toEqual(
            Exit.fail(
              new SolarForecastNotAvailableError({
                message: "Unable to fetch forecast and no valid cache available",
              })
            )
          );
          // API should have been called (attempted)
          expect(callTracker.count).toBe(1);
        }).pipe(
          Effect.provide(
            getTestLayer(makeMockHttpClient({}, 500, callTracker)) // API fails, no file cache
          )
        );
      }
    );
  });
});
