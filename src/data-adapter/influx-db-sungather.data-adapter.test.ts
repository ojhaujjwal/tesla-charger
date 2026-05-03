import { Effect, Exit, Redacted } from "effect";
import { SunGatherInfluxDbDataAdapter } from "./influx-db-sungather.data-adapter.js";
import { SourceNotAvailableError } from "./types.js";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { describe, it, expect } from "@effect/vitest";
import { RequestError } from "@effect/platform/HttpClientError";

// Helper to create a mock HttpResponse
const mockResponse = (req: HttpClientRequest.HttpClientRequest, text: string): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    req,
    // Simulate a response from a server
    new Response(text)
  );

// Custom HttpClient using HttpClient.make
const makeMockHttpClient = (responseText: string): HttpClient.HttpClient =>
  HttpClient.make((req) => Effect.succeed(mockResponse(req, responseText)));

describe("SunGatherInfluxDbDataAdapter", () => {
  it.effect("should parse InfluxDB CSV and return correct values for requested fields", () =>
    Effect.gen(function* () {
      const mockResponseText = `
      ,result,table,_start,_stop,_time,_value,_field,_measurement,inverter
      ,_result,0,2025-06-12T09:45:12.17287821Z,2025-06-12T10:45:12.17287821Z,2025-06-12T10:45:03.724158402Z,0,export_to_grid,export_to_grid,SG10RS
      ,_result,1,2025-06-12T09:45:12.17287821Z,2025-06-12T10:45:12.17287821Z,2025-06-12T10:45:03.724158402Z,254,import_from_grid,import_from_grid,SG10RS
      ,_result,2,2025-06-12T09:45:12.17287821Z,2025-06-12T10:45:12.17287821Z,2025-06-12T10:45:03.724158402Z,238,phase_a_voltage,phase_a_voltage,SG10RS
      `.trim();

      const mockHttpClient = makeMockHttpClient(mockResponseText);

      const adapter = new SunGatherInfluxDbDataAdapter(
        "http://localhost:8086",
        Redacted.make("test-token"),
        "test-org",
        "test-bucket",
        mockHttpClient
      );

      const result = yield* adapter.queryLatestValues(["export_to_grid"]);
      expect(result).toStrictEqual({ export_to_grid: 0 });
    })
  );

  it.effect("should fail with SourceNotAvailableError if http client returns RequestError", () =>
    Effect.gen(function* () {
      const failingHttpClient: HttpClient.HttpClient = HttpClient.make((req) =>
        Effect.fail(new RequestError({ reason: "Transport", request: req }))
      );

      const adapter = new SunGatherInfluxDbDataAdapter(
        "http://localhost:8086",
        Redacted.make("test-token"),
        "test-org",
        "test-bucket",
        failingHttpClient
      );

      const result = yield* Effect.exit(adapter.queryLatestValues(["export_to_grid"]));
      expect(result).toStrictEqual(Exit.fail(new SourceNotAvailableError()));
    })
  );
});
