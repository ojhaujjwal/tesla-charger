import { Schema } from "effect";

export const TeslaTokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
});

export type TeslaTokenResponse = typeof TeslaTokenResponseSchema.Type

export const TeslaErrorResponseSchema = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String),
});

export type TeslaErrorResponse = typeof TeslaErrorResponseSchema.Type
