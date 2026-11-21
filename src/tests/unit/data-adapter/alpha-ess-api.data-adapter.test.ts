import { Cause, ConfigProvider, Effect, Option, Exit, Layer } from "effect";
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

  it.effect("should fail with DataNotAvailableError when calling getLowestValueInLastXMinutes", () =>
    Effect.gen(function* () {
      const adapter = yield* DataAdapter;

      const result = yield* Effect.exit(adapter.getLowestValueInLastXMinutes("current_production", 10));
      const resultErr = Exit.match(result, {
        onSuccess: () => {
          throw new Error("Expected failure");
        },
        onFailure: (cause) => Option.getOrThrow(Cause.findErrorOption(cause))
      });
      expect(resultErr).toBeInstanceOf(DataNotAvailableError);
    }).pipe(Effect.provide(adapterLayer(makeMockHttpClient({}))))
  );
});
