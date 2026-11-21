import { Cause, ConfigProvider, Effect, Exit, Layer, Option } from "effect";
import { SunGatherInfluxDbDataAdapterLayer } from "../../../data-adapter/influx-db-sungather.data-adapter.js";
import { DataAdapter, SourceNotAvailableError } from "../../../data-adapter/types.js";
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpClientError } from "effect/http";
import { describe, it, expect } from "@effect/vitest";

const mockResponse = (req: HttpClientRequest.HttpClientRequest, text: string): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(req, new Response(text));

const makeMockHttpClient = (responseText: string): HttpClient.HttpClient =>
  HttpClient.make((req) => Effect.succeed(mockResponse(req, responseText)));

const TestConfigLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    INFLUX_URL: "http://localhost:8086",
    INFLUX_TOKEN: "test-token",
    INFLUX_ORG: "test-org",
    INFLUX_BUCKET: "test-bucket"
  })
);

const adapterLayer = (httpClient: HttpClient.HttpClient) =>
  SunGatherInfluxDbDataAdapterLayer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
    Layer.provide(TestConfigLayer)
  );

describe("SunGatherInfluxDbDataAdapter", () => {
  it.effect("should parse InfluxDB CSV and return correct values for requested fields", () => {
    const mockResponseText = `
      ,result,table,_start,_stop,_time,_value,_field,_measurement,inverter
      ,_result,0,2025-06-12T09:45:12.17287821Z,2025-06-12T10:45:12.17287821Z,2025-06-12T10:45:03.724158402Z,0,export_to_grid,export_to_grid,SG10RS
      ,_result,1,2025-06-12T09:45:12.17287821Z,2025-06-12T10:45:12.17287821Z,2025-06-12T10:45:03.724158402Z,254,import_from_grid,import_from_grid,SG10RS
      ,_result,2,2025-06-12T09:45:12.17287821Z,2025-06-12T10:45:12.17287821Z,2025-06-12T10:45:03.724158402Z,238,phase_a_voltage,phase_a_voltage,SG10RS
      `.trim();

    return Effect.gen(function* () {
      const adapter = yield* DataAdapter;
      const result = yield* adapter.queryLatestValues(["export_to_grid"]);
      expect(result).toStrictEqual({ export_to_grid: 0 });
    }).pipe(Effect.provide(adapterLayer(makeMockHttpClient(mockResponseText))));
  });

  it.effect("should fail with SourceNotAvailableError if http client returns RequestError", () => {
    const failingHttpClient: HttpClient.HttpClient = HttpClient.make((req, _url, _signal, _fiber) =>
      Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request: req }) }))
    );

    return Effect.gen(function* () {
      const adapter = yield* DataAdapter;
      const result = yield* Effect.exit(adapter.queryLatestValues(["export_to_grid"]));
      const error = Exit.match(result, {
        onSuccess: () => {
          throw new Error("Expected failure");
        },
        onFailure: (cause) => Option.getOrThrow(Cause.findErrorOption(cause))
      });
      expect(error).toBeInstanceOf(SourceNotAvailableError);
    }).pipe(Effect.provide(adapterLayer(failingHttpClient)));
  });
});
