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

export const TeslaCachedTokenSchema = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
});


export type TeslaCachedToken = typeof TeslaCachedTokenSchema.Type;

export const TeslaChargeStateResponseSchema = Schema.Struct({
  response: Schema.Struct({
    charge_state: Schema.Struct({
      battery_level: Schema.Number,
      charge_limit_soc: Schema.Number,
    }),
  }),
});

export type TeslaChargeStateResponse = typeof TeslaChargeStateResponseSchema.Type;
