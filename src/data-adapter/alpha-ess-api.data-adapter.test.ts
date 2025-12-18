import { Effect, Exit } from "effect";
import { AlphaEssCloudApiDataAdapter, type AlphaEssConfig, type ApiResponse } from "./alpha-ess-api.data-adapter.js";
import { type Field, DataNotAvailableError, SourceNotAvailableError } from "./types.js";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { describe, it, expect } from "@effect/vitest";
import { RequestError } from "@effect/platform/HttpClientError";

// Helper to create a mock HttpResponse
const mockResponse = (req: HttpClientRequest.HttpClientRequest, body: string): HttpClientResponse.HttpClientResponse => HttpClientResponse.fromWeb(
  req,
  new Response(body, {
    headers: { 'Content-Type': 'application/json' }
  })
);

// Custom HttpClient using HttpClient.make
const makeMockHttpClient = (responseJson: unknown): HttpClient.HttpClient =>
  HttpClient.make(
    (req) => Effect.succeed(mockResponse(req, JSON.stringify(responseJson)))
  );

describe("AlphaEssCloudApiDataAdapter", () => {
  const mockConfig: AlphaEssConfig = {
    appId: "test-app-id",
    appSecret: "test-app-secret",
    sysSn: "test-sys-sn",
    baseUrl: "https://test.alphaess.com"
  };

  it("should parse Alpha ESS API response and return correct values for requested fields", async () => {
    const mockResponseJson: ApiResponse = {
      code: 200,
      msg: "Success",
      expMsg: null,
      data: {
        ppv: 5000,
        ppvDetail: {
          ppv1: 1000,
          ppv2: 1500,
          ppv3: 1200,
          ppv4: 1300,
          pmeterDc: 5000
        },
        soc: 85,
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
        pbat: -500,
        pgrid: -1200,
        pload: 3300,
        pgridDetail: {
          pmeterL1: -400,
          pmeterL2: -450,
          pmeterL3: -350
        }
      },
      extra: null
    };

    const mockHttpClient = makeMockHttpClient(mockResponseJson);

    const adapter = new AlphaEssCloudApiDataAdapter(
      mockConfig,
      mockHttpClient
    );

    const fields: Field[] = ["current_production", "current_load", "export_to_grid", "import_from_grid", "voltage", 'daily_import'];
    const effect = adapter.queryLatestValues(fields);

    const result = await Effect.runPromise(effect);

    expect(result).toEqual({
      current_production: 1300,  // ppv4
      current_load: 3300,         // pload
      export_to_grid: 1200,       // |pgrid| when negative
      import_from_grid: 0,        // pgrid when positive
      voltage: 235,               // hardcoded value
      daily_import: 0,  // Not supported, returns 0
    });
  });

  it("should handle import from grid correctly when pgrid is positive", async () => {
    const mockResponseJson = {
      code: 200,
      msg: "Success",
      expMsg: null,
      data: {
        ppv: 2000,
        ppvDetail: {
          ppv1: 500,
          ppv2: 600,
          ppv3: 400,
          ppv4: 500,
          pmeterDc: 2000
        },
        soc: 50,
        pev: 0,
        pevDetail: {
          ev1Power: null,
          ev2Power: null,
          ev3Power: null,
          ev4Power: null
        },
        prealL1: 1000,
        prealL2: 1100,
        prealL3: 1050,
        pbat: 500,
        pgrid: 800,  // Positive = importing from grid
        pload: 3500,
        pgridDetail: {
          pmeterL1: 300,
          pmeterL2: 250,
          pmeterL3: 250
        }
      },
      extra: null
    };

    const mockHttpClient = makeMockHttpClient(mockResponseJson);

    const adapter = new AlphaEssCloudApiDataAdapter(
      mockConfig,
      mockHttpClient
    );

    const fields: Field[] = ["export_to_grid", "import_from_grid"];
    const effect = adapter.queryLatestValues(fields);

    const result = await Effect.runPromise(effect);

    expect(result).toEqual({
      export_to_grid: 0,        // pgrid is positive, so no export
      import_from_grid: 800,    // pgrid when positive
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

    const mockHttpClient = makeMockHttpClient(invalidResponse);

    const adapter = new AlphaEssCloudApiDataAdapter(
      mockConfig,
      mockHttpClient
    );

    const result = yield* Effect.exit(adapter.queryLatestValues(["current_production"]));
    
    // Should die with RuntimeException due to schema validation failure
    if (Exit.isFailure(result)) {
      expect(result.cause._tag).toBe("Die");
    } else{
      throw new Error("Expected failure but got success");
    }
  }));

  it.effect("should fail with SourceNotAvailableError if http client returns RequestError", () => Effect.gen(function* () {
    const failingHttpClient: HttpClient.HttpClient = HttpClient.make((req) =>
      Effect.fail(new RequestError({ reason: "Transport", request: req }))
    );

    const adapter = new AlphaEssCloudApiDataAdapter(
      mockConfig,
      failingHttpClient
    );

    const result = yield* Effect.exit(adapter.queryLatestValues(["current_production"]));
    expect(result).toStrictEqual(Exit.fail(new SourceNotAvailableError()));
  }));

  it.effect("should fail with DataNotAvailableError when calling getLowestValueInLastXMinutes", () => Effect.gen(function* () {
    const mockHttpClient = makeMockHttpClient({});

    const adapter = new AlphaEssCloudApiDataAdapter(
      mockConfig,
      mockHttpClient
    );

    const result = yield* Effect.exit(adapter.getLowestValueInLastXMinutes());
    expect(result).toStrictEqual(Exit.fail(new DataNotAvailableError()));
  }));
});
