import { Duration, Effect, Exit, Fiber, Layer, TestClock } from "effect";
import { AlphaEssCloudApiDataAdapter, AlphaEssCloudApiDataAdapterLayer, type AlphaEssConfig, type ApiResponse } from "./alpha-ess-api.data-adapter.js";
import { DataAdapter, DataNotAvailableError, SourceNotAvailableError } from "./types.js";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { describe, it, expect } from "@effect/vitest";
import { RequestError, ResponseError } from "@effect/platform/HttpClientError";

// Helper to create a mock HttpResponse
const mockResponse = (req: HttpClientRequest.HttpClientRequest, body: string): HttpClientResponse.HttpClientResponse => HttpClientResponse.fromWeb(
  req,
  new Response(body, {
    headers: { 'Content-Type': 'application/json' }
  })
);

// Custom HttpClient using HttpClient.make
const makeMockHttpClient = (responseJson: ApiResponse): HttpClient.HttpClient =>
  HttpClient.make(
    (req) => Effect.succeed(mockResponse(req, JSON.stringify(responseJson)))
  );


// Hacky way to set config for now
// until I figure out how to do this properly in tests
process.env.ALPHA_ESS_API_APP_ID = 'asdfasdf';
process.env.ALPHA_ESS_API_APP_SECRET = 'asdfasfasdf';
process.env.ALPHA_ESS_API_SYS_SN = 'asdfasdf';

describe("AlphaEssCloudApiDataAdapter", () => {
  const mockConfig: AlphaEssConfig = {
    appId: "test-app-id",
    appSecret: "test-app-secret",
    sysSn: "test-sys-sn",
    baseUrl: "https://test.alphaess.com"
  };

  describe('should parse Alpha ESS API response and return correct values for requested fields', () => {
    [
      [
        'when solar is just enough to power the house and charge the battery',
        {
          soc: 85,
          ppv: 5000,
          pload: 5000,
          pbat: 0,
          pgrid: 0,
        } as const,
        // expected
        {
          current_production: 5000,
          current_load: 5000,
          export_to_grid: 0,
          import_from_grid: 0,
        } as const,
      ] as const,
      [
        'when solar is more than enough to power the house and charge the battery',
        {
          soc: 85,
          ppv: 5000,
          pload: 3000,
          pbat: -2000,
          pgrid: 0
        } as const,
        // expected
        {
          current_production: 5000,
          current_load: 3000,
          export_to_grid: 0,
          import_from_grid: 0,
        } as const
      ] as const,
      [
        'when solar is more than enough to power the house and battery is fully charged and surprlus is being exported to grid',
        {
          soc: 100,
          ppv: 5000,
          pload: 2100,
          pbat: 0,
          pgrid: -2900
        } as const,
        // expected
        {
          current_production: 5000,
          current_load: 2100,
          export_to_grid: 2900,
          import_from_grid: 0,
        } as const
      ] as const,


      [
        'when solar production and battery export is not enough to power the house ',
        {
          soc: 90,
          ppv: 1200,
          pload: 7000,
          pbat: -5000,
          pgrid: 800
        } as const,
        // expected
        {
          current_production: 1200,
          current_load: 7000,
          export_to_grid: 0,
          import_from_grid: 800,
        } as const
      ] as const,
    ].forEach(([caseTitle, rawData, expectedData]) => {
      it.effect(caseTitle, () => (Effect.gen(function* () {
        const adapter = yield* DataAdapter;

        const result = yield* adapter.queryLatestValues(["current_production", "current_load", "export_to_grid", "import_from_grid", "voltage", 'daily_import']);

        expect(result).toEqual({
          voltage: 235,               // hardcoded value
          daily_import: 0,  // Not supported, returns 0
          ...expectedData,
        });
      }).pipe(
        Effect.provide(
          Layer.provide(
            AlphaEssCloudApiDataAdapterLayer,
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
                  ...rawData,
                },
                extra: null
              })
            )
          )
        ),
      )));
    });
  });

  it.effect("should fail with DataNotAvailableError if API returns non-200 code", () => Effect.gen(function* () {
    const errorResponse = {
      code: 400,
      msg: "Bad Request",
      expMsg: "Invalid parameters",
      data: null,
      extra: null
    };

    const mockHttpClient = makeMockHttpClient(errorResponse);

    const adapter = new AlphaEssCloudApiDataAdapter(
      mockConfig,
      mockHttpClient
    );

    const result = yield* Effect.exit(adapter.queryLatestValues(["current_production"]));
    expect(result).toStrictEqual(Exit.fail(new DataNotAvailableError()));
  }));

  it.effect("should die with RuntimeException if response has invalid structure", () => Effect.gen(function* () {
    const invalidResponse = {
      code: 200,
      msg: "Success",
      expMsg: null,
      data: { invalid: "structure" },
      extra: null
    };

    const mockHttpClient = makeMockHttpClient(invalidResponse as never);

    const adapter = new AlphaEssCloudApiDataAdapter(
      mockConfig,
      mockHttpClient
    );

    const result = yield* Effect.exit(adapter.queryLatestValues(["current_production"]));

    // Should die with RuntimeException due to schema validation failure
    if (Exit.isFailure(result)) {
      expect(result.cause._tag).toBe("Die");
    } else {
      throw new Error("Expected failure but got success");
    }
  }));

  it.effect("should retry on Transport RequestError and eventually fail with SourceNotAvailableError", () => Effect.gen(function* () {
    let calls = 0;
    const failingHttpClient: HttpClient.HttpClient = HttpClient.make((req) => {
      calls++;
      return Effect.fail(new RequestError({ reason: "Transport", request: req }));
    });

    const adapter = new AlphaEssCloudApiDataAdapter(
      mockConfig,
      failingHttpClient
    );

    const fiber = yield* Effect.fork(adapter.queryLatestValues(["current_production"]));
    yield* TestClock.adjust(Duration.seconds(70)); // Total retry time is ~62s
    const result = yield* Fiber.await(fiber);

    expect(result).toStrictEqual(Exit.fail(new SourceNotAvailableError()));
    expect(calls).toBe(6);
  }));

  it.effect("should NOT retry on ResponseError (HTTP 4xx/5xx)", () => Effect.gen(function* () {
    let calls = 0;
    const failingHttpClient: HttpClient.HttpClient = HttpClient.make((req) => {
      calls++;
      return Effect.fail(new ResponseError({
        reason: "StatusCode",
        request: req,
        response: HttpClientResponse.fromWeb(req, new Response(null, { status: 500 }))
      }));
    });

    const adapter = new AlphaEssCloudApiDataAdapter(
      mockConfig,
      failingHttpClient
    );

    const result = yield* Effect.exit(adapter.queryLatestValues(["current_production"]));
    expect(result).toStrictEqual(Exit.fail(new SourceNotAvailableError()));
    expect(calls).toBe(1);
  }));

  it.effect("should NOT retry on RequestError with reason 'InvalidUrl'", () => Effect.gen(function* () {
    let calls = 0;
    const failingHttpClient: HttpClient.HttpClient = HttpClient.make((req) => {
      calls++;
      return Effect.fail(new RequestError({ reason: "InvalidUrl", request: req }));
    });

    const adapter = new AlphaEssCloudApiDataAdapter(
      mockConfig,
      failingHttpClient
    );

    const result = yield* Effect.exit(adapter.queryLatestValues(["current_production"]));
    expect(result).toStrictEqual(Exit.fail(new SourceNotAvailableError()));
    expect(calls).toBe(1);
  }));

  it.effect("should fail with DataNotAvailableError when calling getLowestValueInLastXMinutes", () => Effect.gen(function* () {
    const mockHttpClient = makeMockHttpClient({} as never);

    const adapter = new AlphaEssCloudApiDataAdapter(
      mockConfig,
      mockHttpClient
    );

    const result = yield* Effect.exit(adapter.getLowestValueInLastXMinutes());
    expect(result).toStrictEqual(Exit.fail(new DataNotAvailableError()));
  }));
});
