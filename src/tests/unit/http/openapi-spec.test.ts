import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { NodeHttpServer } from "@effect/platform-node";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { ValidationErrorHandler, ValidationErrorHandlerLayer } from "../../../http/validation-error.js";

const TestPayloadSchema = Schema.Struct({
  value: Schema.Finite.pipe(Schema.annotate({ message: "Expected a numeric value", identifier: "a numeric value" }))
});

class TestValidationGroup extends HttpApiGroup.make("testValidation", { topLevel: true })
  .add(
    HttpApiEndpoint.get("getValue", "/test-value", {
      success: TestPayloadSchema
    }),
    HttpApiEndpoint.patch("setValue", "/test-value", {
      payload: TestPayloadSchema,
      success: TestPayloadSchema
    })
  )
  .middleware(ValidationErrorHandler) {}

describe("OpenAPI spec validation", () => {
  it("generates 400 response schema with { kind, message } for endpoints with validation middleware", () => {
    class TestApi extends HttpApi.make("test-api")
      .add(TestValidationGroup)
      .annotateMerge(
        OpenApi.annotations({
          title: "Test API",
          description: "Test API for OpenAPI spec validation"
        })
      ) {}

    const spec = OpenApi.fromApi(TestApi);

    expect(spec).toHaveProperty("openapi");
    expect(spec).toHaveProperty("info.title", "Test API");

    const path = "paths./test-value";

    expect(spec).not.toHaveProperty(path + ".get.responses.500");
    expect(spec).not.toHaveProperty(path + ".patch.responses.500");

    expect(spec).toHaveProperty(path + ".get.responses.200");
    expect(spec).toHaveProperty(path + ".get.responses.400");
    expect(spec).toHaveProperty(path + ".patch.responses.200");
    expect(spec).toHaveProperty(path + ".patch.responses.400");

    const schema = (suffix: string) => path + "." + suffix + ".responses.400.content.application/json.schema";
    expect(spec).toHaveProperty(schema("get") + ".properties.kind");
    expect(spec).toHaveProperty(schema("get") + ".properties.message");
    expect(spec).not.toHaveProperty(schema("get") + ".properties._tag");
    expect(spec).toHaveProperty(schema("patch") + ".properties.kind");
    expect(spec).toHaveProperty(schema("patch") + ".properties.message");
    expect(spec).not.toHaveProperty(schema("patch") + ".properties._tag");
  });

  it.effect("PATCH /test-value with invalid body returns 400 status and { kind, message } body", () =>
    Effect.gen(function* () {
      class TestApi extends HttpApi.make("test-api").add(TestValidationGroup) {}

      const groupLayer = HttpApiBuilder.group(
        TestApi,
        "testValidation",
        Effect.fnUntraced(function* (handlers) {
          yield* Effect.void;
          return handlers
            .handle("getValue", () => Effect.succeed({ value: 42 }))
            .handle("setValue", ({ payload }) => Effect.succeed({ value: payload.value }));
        })
      );

      const routes = HttpApiBuilder.layer(TestApi).pipe(
        Layer.provide(groupLayer),
        Layer.provide(ValidationErrorHandlerLayer)
      );

      yield* HttpRouter.serve(routes).pipe(Layer.build);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.patch("/test-value", {
        body: HttpBody.raw(JSON.stringify({ value: "not-a-number" }), {
          contentType: "application/json"
        })
      });
      expect(response.status).toBe(400);
      const body = yield* response.json;
      expect(body).toHaveProperty("kind");
      expect(body).toHaveProperty("message");
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  );
});
