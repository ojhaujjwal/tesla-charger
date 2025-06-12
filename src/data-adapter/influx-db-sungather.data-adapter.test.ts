import { Data, Effect, Exit } from "effect";
import { SunGatherInfluxDbDataAdapter } from "./influx-db-sungather.data-adapter.js";
import { type Field, DataNotAvailableError, SourceNotAvailableError } from "./types.js";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { describe, it, expect } from "@effect/vitest";
import { RequestError } from "@effect/platform/HttpClientError";

// Helper to create a mock HttpResponse
const mockResponse = (req: HttpClientRequest.HttpClientRequest, text: string): HttpClientResponse.HttpClientResponse => HttpClientResponse.fromWeb(
  req,
  // Simulate a response from a server
  new Response(text)
);

// Custom HttpClient using HttpClient.make
const makeMockHttpClient = (responseText: string): HttpClient.HttpClient =>
  HttpClient.make(
    (req) => Effect.succeed(mockResponse(req, responseText))
  );

export class TestShouldFailError extends Data.Error {
  public readonly message = 'No data found to determine the result.';
}


describe("SunGatherInfluxDbDataAdapter", () => {
  it("should parse InfluxDB CSV and return correct values for requested fields", async () => {
    const mockResponseText = `
,result,table,_start,_stop,_time,_value,_field,_measurement,inverter
,_result,0,2025-06-12T09:45:12.17287821Z,2025-06-12T10:45:12.17287821Z,2025-06-12T10:45:03.724158402Z,0,export_to_grid,export_to_grid,SG10RS
,_result,1,2025-06-12T09:45:12.17287821Z,2025-06-12T10:45:12.17287821Z,2025-06-12T10:45:03.724158402Z,254,import_from_grid,import_from_grid,SG10RS
,_result,2,2025-06-12T09:45:12.17287821Z,2025-06-12T10:45:12.17287821Z,2025-06-12T10:45:03.724158402Z,238,phase_a_voltage,phase_a_voltage,SG10RS
`.trim();

    const mockHttpClient = makeMockHttpClient(mockResponseText);

    const adapter = new SunGatherInfluxDbDataAdapter(
      "http://localhost:8086",
      "test-token",
      "test-org",
      "test-bucket",
      mockHttpClient
    );

    const fields: Field[] = ["export_to_grid", "import_from_grid", "voltage"];
    const effect = adapter.queryLatestValues(fields);

    const result = await Effect.runPromise(effect);

    expect(result).toEqual({
      export_to_grid: 0,
      import_from_grid: 254,
      voltage: 238,
    });
  });

  it.effect("should fail with DataNotAvailableError if no data rows", () => Effect.gen(function* () {
    const emptyResponse = ",result,table,_start,_stop,_time,_value,_field,_measurement,inverter";
    const mockHttpClient = makeMockHttpClient(emptyResponse);

    const adapter = new SunGatherInfluxDbDataAdapter(
      "http://localhost:8086",
      "test-token",
      "test-org",
      "test-bucket",
      mockHttpClient
    );

    const result = yield* Effect.exit(adapter.queryLatestValues(["export_to_grid"]));
    expect(result).toStrictEqual(Exit.fail(new DataNotAvailableError()))
  }));

  it.effect("should fail with SourceNotAvailableError if http client returns RequestError", () => Effect.gen(function* () {
    const failingHttpClient: HttpClient.HttpClient = HttpClient.make((req) =>
      Effect.fail(new RequestError({ reason: "Transport", request: req }))
    );

    const adapter = new SunGatherInfluxDbDataAdapter(
      "http://localhost:8086",
      "test-token",
      "test-org",
      "test-bucket",
      failingHttpClient
    );

    const result = yield* Effect.exit(adapter.queryLatestValues(["export_to_grid"]));
    expect(result).toStrictEqual(Exit.fail(new SourceNotAvailableError()));
  }));
});
