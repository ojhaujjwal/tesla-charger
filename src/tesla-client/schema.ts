import { Schema } from "effect";
import { KiloWattHoursFromNumber, StateOfChargeFromNumber } from "../domain/brands.js";

export const TeslaTokenResponseSchema = Schema.Struct({
  access_token: Schema.RedactedFromValue(Schema.String),
  refresh_token: Schema.RedactedFromValue(Schema.String)
});

export type TeslaTokenResponse = Schema.Schema.Type<typeof TeslaTokenResponseSchema>;

export const TeslaCachedTokenSchema = Schema.Struct({
  access_token: Schema.RedactedFromValue(Schema.String),
  refresh_token: Schema.RedactedFromValue(Schema.String)
});

export type TeslaCachedToken = Schema.Schema.Type<typeof TeslaCachedTokenSchema>;

export const TeslaChargeStateResponseSchema = Schema.Struct({
  response: Schema.Struct({
    charge_state: Schema.Struct({
      battery_level: StateOfChargeFromNumber,
      charge_limit_soc: StateOfChargeFromNumber,
      charge_energy_added: KiloWattHoursFromNumber
    })
  })
});

export type TeslaChargeStateResponse = Schema.Schema.Type<typeof TeslaChargeStateResponseSchema>;
