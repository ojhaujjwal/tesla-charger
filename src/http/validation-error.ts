import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiMiddleware } from "effect/unstable/httpapi";

export const ValidationErrorBody = Schema.Struct({
  kind: Schema.String,
  message: Schema.String
}).pipe(Schema.annotate({ httpApiStatus: 400 }));

export class ValidationErrorHandler extends HttpApiMiddleware.Service<ValidationErrorHandler>()(
  "tesla-charger/ValidationErrorHandler",
  { error: ValidationErrorBody }
) {}

export const ValidationErrorHandlerLayer = HttpApiMiddleware.layerSchemaErrorTransform(
  ValidationErrorHandler,
  (schemaError) =>
    Effect.succeed(
      HttpServerResponse.jsonUnsafe(
        {
          kind: schemaError.kind,
          message: schemaError.cause.message
        },
        { status: 400 }
      )
    )
);
