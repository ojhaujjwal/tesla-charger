import { Cause, ConfigProvider, DateTime, Duration, Effect, Option, Exit, Layer } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { AlphaEssCloudApiDataAdapterLayer } from "../../../data-adapter/alpha-ess-api.data-adapter.js";
import { DataAdapter, DataNotAvailableError, SourceNotAvailableError } from "../../../data-adapter/types.js";
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpClientError } from "effect/http";
import { tracerLayer, toJsonSpan, type TraceSpanJson } from "../../../tracing/tracer.js";
import { describe, it, expect } from "@effect/vitest";

const mockResponse = (req: HttpClientRequest.HttpClientRequest, body: string): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    req,
    new Response(body, {
      headers: { "Content-Type": "application/json" }
    })
  );

const makeMockHttpClient = (responseJson: unknown): HttpClient.HttpClient =>
  HttpClient.make((req) => Effect.succeed(mockResponse(req, JSON.stringify(responseJson))));

const powerData = (overrides: Record<string, unknown> = {}) => ({
  ppv: 0,
  ppvDetail: { ppv1: 0, ppv2: 0, ppv3: 0, ppv4: 0, pmeterDc: 0 },
  soc: 0,
  pev: 0,
  pevDetail: { ev1Power: null, ev2Power: null, ev3Power: null, ev4Power: null },
  prealL1: 0,
  prealL2: 0,
  prealL3: 0,
  pbat: 0,
  pgrid: 0,
  pload: 0,
  pgridDetail: { pmeterL1: 0, pmeterL2: 0, pmeterL3: 0 },
  ...overrides
});

const okResponse = {
  code: 200,
  msg: "Success",
  expMsg: null,
  data: powerData(),
  extra: null
};

const historicalSample = (uploadTime: string, overrides: Record<string, unknown> = {}) => ({
  sysSn: "asdfasdf",
  uploadTime,
  ppv: 0,
  load: 0,
  cbat: 50,
  feedIn: 0,
  gridCharge: 0,
  pchargingPile: 0,
  ...overrides
});

const historicalResponse = (samples: ReadonlyArray<unknown>) => ({
  code: 200,
  msg: "Success",
  expMsg: null,
  data: samples,
  extra: null
});

const localZone = DateTime.zoneMakeLocal();

const localTime = (parts: { year: number; month: number; day: number; hour: number; minute: number }) =>
  DateTime.makeZonedUnsafe(parts, { timeZone: localZone, adjustForTimeZone: true });

const wallClock = (dateTime: DateTime.DateTime): string => {
  const { year, month, day, hour, minute, second } = DateTime.toParts(dateTime);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
};

const sampleMinutesAgo = (now: DateTime.DateTime, minutesAgo: number, overrides: Record<string, unknown> = {}) =>
  historicalSample(wallClock(DateTime.subtract(now, { minutes: minutesAgo })), overrides);

const makeHistoricalHttpClient = (responses: Record<string, unknown>, requests: Array<string> = []) =>
  HttpClient.make((req) => {
    requests.push(req.url);
    const queryDate = new URL(req.url).searchParams.get("queryDate");
    const body = queryDate === null ? undefined : responses[queryDate];
    return Effect.succeed(mockResponse(req, JSON.stringify(body ?? {})));
  });

const TestConfigLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    ALPHA_ESS_API_APP_ID: "asdfasdf",
    ALPHA_ESS_API_APP_SECRET: "asdfasfasdf",
    ALPHA_ESS_API_SYS_SN: "asdfasdf",
    ALPHA_ESS_API_BASE_URL: "https://openapi.alphaess.com/"
  })
);

const adapterLayer = (httpClient: HttpClient.HttpClient, configLayer: Layer.Layer<never> = TestConfigLayer) =>
  AlphaEssCloudApiDataAdapterLayer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
    Layer.provide(configLayer)
  );

const queryLatestValues = (httpClient: HttpClient.HttpClient, configLayer: Layer.Layer<never> = TestConfigLayer) =>
  Effect.gen(function* () {
    const adapter = yield* DataAdapter;
    return yield* adapter.queryLatestValues(["current_production"]);
  }).pipe(Effect.provide(adapterLayer(httpClient, configLayer)));

describe("AlphaEssCloudApiDataAdapter", () => {
  it.effect(
    "should apply the tracer header filter and redact the sign and appId request headers in captured spans",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_700_000_000_000);

        const spans: Array<TraceSpanJson> = [];

        yield* queryLatestValues(makeMockHttpClient(okResponse)).pipe(
          Effect.provide(
            tracerLayer({
              minimumTraceLevel: "All",
              onSpan: (span) => spans.push(toJsonSpan(span))
            })
          )
        );

        const httpSpan = spans.find((span) => span.name === "GET");
        expect(httpSpan).toBeDefined();
        expect(httpSpan?.attributes["http.request.header.sign"]).toBe("<redacted>");
        expect(httpSpan?.attributes["http.request.header.appid"]).toBe("<redacted>");
        expect(httpSpan?.attributes["http.request.header.timestamp"]).toBe("1700000000");
      })
  );

  it.effect("should sign requests with the lowercase sha512 hex of appId + appSecret + timestamp", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_700_000_000_999);

      let request: HttpClientRequest.HttpClientRequest | undefined;
      const httpClient = HttpClient.make((req) => {
        request = req;
        return Effect.succeed(mockResponse(req, JSON.stringify(okResponse)));
      });

      yield* queryLatestValues(
        httpClient,
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ALPHA_ESS_API_APP_ID: "known-app-id",
            ALPHA_ESS_API_APP_SECRET: "known-app-secret",
            ALPHA_ESS_API_SYS_SN: "test-sys-sn",
            ALPHA_ESS_API_BASE_URL: "https://test.alphaess.com"
          })
        )
      );

      expect(request?.headers["timestamp"]).toBe("1700000000");
      // Pinned sha512("known-app-id" + "known-app-secret" + "1700000000"), as produced by the previous node:crypto implementation.
      expect(request?.headers["sign"]).toBe(
        "54381952de4476acdfa60c5b513dbe45475eb1e2415fbd19eb6afe040808640d2e75d04a998553ac757ecf498df7e48e62f562c834e9cd03a711c3554fb22dad"
      );
    })
  );

  describe("should parse Alpha ESS API response and return correct values for requested fields", () => {
    [
      [
        "when solar is just enough to power the house and charge the battery",
        {
          soc: 85,
          ppv: 5000,
          pload: 5000,
          pbat: 0,
          pgrid: 0
        } as const,
        {
          current_production: 5000,
          current_load: 5000,
          export_to_grid: 0,
          import_from_grid: 0
        } as const
      ] as const,
      [
        "when solar is more than enough to power the house and charge the battery",
        {
          soc: 85,
          ppv: 5000,
          pload: 3000,
          pbat: -2000,
          pgrid: 0
        } as const,
        {
          current_production: 5000,
          current_load: 3000,
          export_to_grid: 0,
          import_from_grid: 0
        } as const
      ] as const,
      [
        "when solar is more than enough to power the house and battery is fully charged and surprlus is being exported to grid",
        {
          soc: 100,
          ppv: 5000,
          pload: 2100,
          pbat: 0,
          pgrid: -2900
        } as const,
        {
          current_production: 5000,
          current_load: 2100,
          export_to_grid: 2900,
          import_from_grid: 0
        } as const
      ] as const,

      [
        "when solar production and battery export is not enough to power the house ",
        {
          soc: 90,
          ppv: 1200,
          pload: 7000,
          pbat: -5000,
          pgrid: 800
        } as const,
        {
          current_production: 1200,
          current_load: 7000,
          export_to_grid: 0,
          import_from_grid: 800
        } as const
      ] as const
    ].forEach(([caseTitle, rawData, expectedData]) => {
      it.effect(caseTitle, () =>
        Effect.gen(function* () {
          const adapter = yield* DataAdapter;

          const result = yield* adapter.queryLatestValues([
            "current_production",
            "current_load",
            "export_to_grid",
            "import_from_grid",
            "voltage",
            "daily_import"
          ]);

          expect(result).toEqual({
            voltage: 235,
            daily_import: 0,
            ...expectedData
          });
        }).pipe(
          Effect.provide(
            AlphaEssCloudApiDataAdapterLayer.pipe(
              Layer.provide(
                Layer.succeed(
                  HttpClient.HttpClient,
                  makeMockHttpClient({
                    code: 200,
                    msg: "Success",
                    expMsg: null,
                    data: {
                      ppvDetail: {
                        ppv1: 0,
                        ppv2: 0,
                        ppv3: 0,
                        ppv4: 0,
                        pmeterDc: 5000
                      },
                      pev: 0,
                      pevDetail: {
                        ev1Power: null,
                        ev2Power: null,
                        ev3Power: null,
                        ev4Power: null
                      },
                      prealL1: 800,
                      prealL2: 900,
                      prealL3: 850,
                      pgridDetail: {
                        pmeterL1: -400,
                        pmeterL2: -450,
                        pmeterL3: -350
                      },
                      ...rawData
                    },
                    extra: null
                  })
                )
              ),
              Layer.provide(TestConfigLayer)
            )
          )
        )
      );
    });
  });

  it.effect("should fail with DataNotAvailableError if API returns non-200 code", () =>
    Effect.gen(function* () {
      const errorResponse = {
        code: 400,
        msg: "Bad Request",
        expMsg: "Invalid parameters",
        data: null,
        extra: null
      };

      const result = yield* Effect.exit(queryLatestValues(makeMockHttpClient(errorResponse)));
      const resultErr = Exit.match(result, {
        onSuccess: () => {
          throw new Error("Expected failure");
        },
        onFailure: (cause) => Option.getOrThrow(Cause.findErrorOption(cause))
      });
      expect(resultErr).toBeInstanceOf(DataNotAvailableError);
    })
  );

  it.effect("should die with RuntimeException if response has invalid structure", () =>
    Effect.gen(function* () {
      const invalidResponse = {
        code: 200,
        msg: "Success",
        expMsg: null,
        data: { invalid: "structure" },
        extra: null
      };

      const result = yield* Effect.exit(queryLatestValues(makeMockHttpClient(invalidResponse)));

      if (Exit.isFailure(result)) {
        expect(Cause.hasDies(result.cause)).toBe(true);
      } else {
        throw new Error("Expected failure but got success");
      }
    })
  );

  it.effect("should retry on Transport RequestError and eventually fail with SourceNotAvailableError", () =>
    Effect.gen(function* () {
      let calls = 0;
      const failingHttpClient = HttpClient.make((req, _url, _signal, _fiber) => {
        calls++;
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.StatusCodeError({
              request: req,
              response: HttpClientResponse.fromWeb(req, new Response(null, { status: 500 }))
            })
          })
        );
      });

      const result = yield* Effect.exit(queryLatestValues(failingHttpClient));

      const resultErr = Exit.match(result, {
        onSuccess: () => {
          throw new Error("Expected failure");
        },
        onFailure: (cause) => Option.getOrThrow(Cause.findErrorOption(cause))
      });
      expect(resultErr).toBeInstanceOf(SourceNotAvailableError);
      expect(calls).toBe(1);
    })
  );

  it.effect("should NOT retry on ResponseError (HTTP 4xx/5xx)", () =>
    Effect.gen(function* () {
      let calls = 0;
      const failingHttpClient = HttpClient.make((req, _url, _signal, _fiber) => {
        calls++;
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.StatusCodeError({
              request: req,
              response: HttpClientResponse.fromWeb(req, new Response(null, { status: 500 }))
            })
          })
        );
      });

      const result = yield* Effect.exit(queryLatestValues(failingHttpClient));
      const resultErr = Exit.match(result, {
        onSuccess: () => {
          throw new Error("Expected failure");
        },
        onFailure: (cause) => Option.getOrThrow(Cause.findErrorOption(cause))
      });
      expect(resultErr).toBeInstanceOf(SourceNotAvailableError);
      expect(calls).toBe(1);
    })
  );

  it.effect("should NOT retry on RequestError with reason 'InvalidUrl'", () =>
    Effect.gen(function* () {
      let calls = 0;
      const failingHttpClient = HttpClient.make((req, _url, _signal, _fiber) => {
        calls++;
        return Effect.fail(
          new HttpClientError.HttpClientError({ reason: new HttpClientError.InvalidUrlError({ request: req }) })
        );
      });

      const result = yield* Effect.exit(queryLatestValues(failingHttpClient));
      const resultErr = Exit.match(result, {
        onSuccess: () => {
          throw new Error("Expected failure");
        },
        onFailure: (cause) => Option.getOrThrow(Cause.findErrorOption(cause))
      });
      expect(resultErr).toBeInstanceOf(SourceNotAvailableError);
      expect(calls).toBe(1);
    })
  );

  it.effect("should return the lowest historical value from the last X minutes", () => {
    const now = localTime({ year: 2026, month: 8, day: 4, hour: 12, minute: 0 });
    const requests: Array<string> = [];
    const httpClient = makeHistoricalHttpClient(
      {
        [DateTime.formatIsoDate(now)]: historicalResponse([
          sampleMinutesAgo(now, 35, { ppv: 100 }),
          sampleMinutesAgo(now, 25, { ppv: 400 }),
          sampleMinutesAgo(now, 20, { ppv: 300 }),
          sampleMinutesAgo(now, 10, { ppv: 200 }),
          sampleMinutesAgo(now, 5, { ppv: 500 })
        ])
      },
      requests
    );

    return Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(now));

      const adapter = yield* DataAdapter;
      const result = yield* adapter.getLowestValueInLastXMinutes("current_production", 30);

      expect(result).toBe(200);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("/api/getOneDayPowerBySn");
      expect(requests[0]).toContain(`queryDate=${DateTime.formatIsoDate(now)}`);
    }).pipe(Effect.provide(adapterLayer(httpClient)));
  });

  it.effect("should not make another request for a second call within the same 5-minute sample slot", () => {
    const now = localTime({ year: 2026, month: 8, day: 4, hour: 12, minute: 0 });
    const requests: Array<string> = [];
    const httpClient = makeHistoricalHttpClient(
      {
        [DateTime.formatIsoDate(now)]: historicalResponse([
          sampleMinutesAgo(now, 25, { ppv: 400 }),
          sampleMinutesAgo(now, 5, { ppv: 500 })
        ])
      },
      requests
    );

    return Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(now));

      const adapter = yield* DataAdapter;
      yield* adapter.getLowestValueInLastXMinutes("current_production", 30);
      expect(requests).toHaveLength(1);

      yield* TestClock.adjust(Duration.minutes(4));
      const result = yield* adapter.getLowestValueInLastXMinutes("current_production", 30);

      expect(result).toBe(400);
      expect(requests).toHaveLength(1);
    }).pipe(Effect.provide(adapterLayer(httpClient)));
  });

  it.effect("should refetch a day once the 5-minute sample slot boundary passes", () => {
    const now = localTime({ year: 2026, month: 8, day: 4, hour: 12, minute: 0 });
    const requests: Array<string> = [];
    let response = historicalResponse([sampleMinutesAgo(now, 25, { ppv: 400 })]);
    const httpClient = HttpClient.make((req) => {
      requests.push(req.url);
      return Effect.succeed(mockResponse(req, JSON.stringify(response)));
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(now));

      const adapter = yield* DataAdapter;
      expect(yield* adapter.getLowestValueInLastXMinutes("current_production", 30)).toBe(400);
      expect(requests).toHaveLength(1);

      yield* TestClock.adjust(Duration.minutes(5));
      response = historicalResponse([sampleMinutesAgo(now, 25, { ppv: 400 }), sampleMinutesAgo(now, 2, { ppv: 150 })]);

      expect(yield* adapter.getLowestValueInLastXMinutes("current_production", 30)).toBe(150);
      expect(requests).toHaveLength(2);
    }).pipe(Effect.provide(adapterLayer(httpClient)));
  });

  it.effect("should compute the minimum across cached and freshly fetched days", () => {
    const now = localTime({ year: 2026, month: 8, day: 4, hour: 0, minute: 10 });
    const today = DateTime.formatIsoDate(now);
    const yesterday = DateTime.formatIsoDate(DateTime.subtract(now, { days: 1 }));
    const requests: Array<string> = [];
    const httpClient = makeHistoricalHttpClient(
      {
        [today]: historicalResponse([sampleMinutesAgo(now, 8, { ppv: 300 }), sampleMinutesAgo(now, 4, { ppv: 250 })]),
        [yesterday]: historicalResponse([sampleMinutesAgo(now, 20, { ppv: 90 })])
      },
      requests
    );

    return Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(now));

      const adapter = yield* DataAdapter;
      expect(yield* adapter.getLowestValueInLastXMinutes("current_production", 10)).toBe(250);
      expect(requests).toHaveLength(1);

      expect(yield* adapter.getLowestValueInLastXMinutes("current_production", 30)).toBe(90);
      expect(requests).toHaveLength(2);
    }).pipe(Effect.provide(adapterLayer(httpClient)));
  });

  it.effect("should re-apply the window filter to cached samples", () => {
    const now = localTime({ year: 2026, month: 8, day: 4, hour: 12, minute: 0 });
    const requests: Array<string> = [];
    const httpClient = makeHistoricalHttpClient(
      {
        [DateTime.formatIsoDate(now)]: historicalResponse([
          sampleMinutesAgo(now, 50, { ppv: 10 }),
          sampleMinutesAgo(now, 10, { ppv: 200 })
        ])
      },
      requests
    );

    return Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(now));

      const adapter = yield* DataAdapter;
      expect(yield* adapter.getLowestValueInLastXMinutes("current_production", 60)).toBe(10);

      yield* TestClock.adjust(Duration.minutes(1));
      expect(yield* adapter.getLowestValueInLastXMinutes("current_production", 30)).toBe(200);
      expect(requests).toHaveLength(1);
    }).pipe(Effect.provide(adapterLayer(httpClient)));
  });

  it.effect("should include the previous day when the window crosses midnight", () => {
    const now = localTime({ year: 2026, month: 8, day: 4, hour: 0, minute: 10 });
    const today = DateTime.formatIsoDate(now);
    const yesterday = DateTime.formatIsoDate(DateTime.subtract(now, { days: 1 }));
    const requests: Array<string> = [];
    const httpClient = makeHistoricalHttpClient(
      {
        [yesterday]: historicalResponse([
          sampleMinutesAgo(now, 35, { ppv: 50 }),
          sampleMinutesAgo(now, 25, { ppv: 120 }),
          sampleMinutesAgo(now, 15, { ppv: 80 })
        ]),
        [today]: historicalResponse([sampleMinutesAgo(now, 5, { ppv: 300 })])
      },
      requests
    );

    return Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(now));

      const adapter = yield* DataAdapter;
      const result = yield* adapter.getLowestValueInLastXMinutes("current_production", 30);

      expect(result).toBe(80);
      expect(requests).toHaveLength(2);
      expect(requests.some((url) => url.includes(`queryDate=${yesterday}`))).toBe(true);
      expect(requests.some((url) => url.includes(`queryDate=${today}`))).toBe(true);
    }).pipe(Effect.provide(adapterLayer(httpClient)));
  });

  it.effect("should fail with DataNotAvailableError when the window has no samples", () => {
    const now = localTime({ year: 2026, month: 8, day: 4, hour: 12, minute: 0 });
    const httpClient = makeHistoricalHttpClient({
      [DateTime.formatIsoDate(now)]: historicalResponse([])
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(now));

      const adapter = yield* DataAdapter;
      const result = yield* Effect.exit(adapter.getLowestValueInLastXMinutes("current_production", 30));
      const resultErr = Exit.match(result, {
        onSuccess: () => {
          throw new Error("Expected failure");
        },
        onFailure: (cause) => Option.getOrThrow(Cause.findErrorOption(cause))
      });
      expect(resultErr).toBeInstanceOf(DataNotAvailableError);
    }).pipe(Effect.provide(adapterLayer(httpClient)));
  });

  it.effect("should fail with DataNotAvailableError for a field the historical endpoint does not expose", () => {
    const requests: Array<string> = [];
    const httpClient = makeHistoricalHttpClient({}, requests);

    return Effect.gen(function* () {
      const adapter = yield* DataAdapter;
      const result = yield* Effect.exit(adapter.getLowestValueInLastXMinutes("voltage", 30));
      const resultErr = Exit.match(result, {
        onSuccess: () => {
          throw new Error("Expected failure");
        },
        onFailure: (cause) => Option.getOrThrow(Cause.findErrorOption(cause))
      });
      expect(resultErr).toBeInstanceOf(DataNotAvailableError);
      expect(requests).toHaveLength(0);
    }).pipe(Effect.provide(adapterLayer(httpClient)));
  });
});
