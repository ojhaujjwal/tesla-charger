import { Schema } from "effect";

export const TeslaTokenResponseSchema = Schema.Struct({
  access_token: Schema.RedactedFromValue(Schema.String),
  refresh_token: Schema.RedactedFromValue(Schema.String)
});

export type TeslaTokenResponse = Schema.Schema.Type<typeof TeslaTokenResponseSchema>;

export const TeslaErrorResponseSchema = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String)
});

export type TeslaErrorResponse = Schema.Schema.Type<typeof TeslaErrorResponseSchema>;

export const TeslaCachedTokenSchema = Schema.Struct({
  access_token: Schema.RedactedFromValue(Schema.String),
  refresh_token: Schema.RedactedFromValue(Schema.String)
});

export type TeslaCachedToken = Schema.Schema.Type<typeof TeslaCachedTokenSchema>;

export const TeslaChargeStateResponseSchema = Schema.Struct({
  response: Schema.Struct({
    charge_state: Schema.Struct({
      battery_level: Schema.Number,
      charge_limit_soc: Schema.Number,
      charge_energy_added: Schema.Number
    })
  })
});

export type TeslaChargeStateResponse = Schema.Schema.Type<typeof TeslaChargeStateResponseSchema>;
