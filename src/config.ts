import { Config as EffectConfig } from "effect";
import { Ampere, AmpereFromString } from "./domain/brands.js";

export const AppConfig = {
  nodeEnv: EffectConfig.string("NODE_ENV").pipe(EffectConfig.withDefault("production")),

  sentry: {
    dsn: EffectConfig.string("SENTRY_DSN")
  },

  tesla: {
    appDomain: EffectConfig.string("TESLA_APP_DOMAIN"),
    oauth2ClientId: EffectConfig.string("TESLA_OAUTH2_CLIENT_ID"),
    oauth2ClientSecret: EffectConfig.redacted("TESLA_OAUTH2_CLIENT_SECRET"),
    vin: EffectConfig.string("TESLA_VIN")
  },

  influx: {
    url: EffectConfig.string("INFLUX_URL"),
    token: EffectConfig.redacted("INFLUX_TOKEN"),
    org: EffectConfig.string("INFLUX_ORG"),
    bucket: EffectConfig.string("INFLUX_BUCKET")
  },

  alphaEssAPI: {
    appId: EffectConfig.redacted("ALPHA_ESS_API_APP_ID"),
    appSecret: EffectConfig.redacted("ALPHA_ESS_API_APP_SECRET"),
    sysSn: EffectConfig.string("ALPHA_ESS_API_SYS_SN"),
    baseUrl: EffectConfig.string("ALPHA_ESS_API_BASE_URL").pipe(
      EffectConfig.withDefault("https://openapi.alphaess.com/")
    )
  },

  solcast: {
    apiKey: EffectConfig.redacted("SOLCAST_API_KEY"),
    rooftopResourceId: EffectConfig.string("SOLCAST_ROOFTOP_RESOURCE_ID")
  },

  controller: {
    fixedSpeedAmpere: EffectConfig.schema(AmpereFromString, "FIXED_SPEED_AMPERE").pipe(
      EffectConfig.withDefault(Ampere(5))
    ),
    maxAllowedFeedInPower: EffectConfig.int("MAX_ALLOWED_FEED_IN_POWER").pipe(EffectConfig.withDefault(5000))
  },

  excessSolar: {
    bufferPower: EffectConfig.int("EXCESS_SOLAR_BUFFER_POWER").pipe(EffectConfig.withDefault(1000))
  },

  weatherAware: {
    minBufferPower: EffectConfig.int("EXCESS_SOLAR_BUFFER_POWER").pipe(EffectConfig.withDefault(500)),
    bufferMultiplierMax: EffectConfig.number("BUFFER_MULTIPLIER_MAX").pipe(EffectConfig.withDefault(3)),
    carBatteryCapacityKwh: EffectConfig.number("CAR_BATTERY_CAPACITY_KWH").pipe(EffectConfig.withDefault(60)),
    peakSolarCapacityKw: EffectConfig.number("SOLCAST_CAPACITY_KW").pipe(EffectConfig.withDefault(9)),
    latitude: EffectConfig.number("SOLCAST_LATITUDE"),
    longitude: EffectConfig.number("SOLCAST_LONGITUDE"),
    defaultDailyProductionKwh: EffectConfig.number("DEFAULT_DAILY_PRODUCTION_KWH").pipe(EffectConfig.withDefault(60)),
    solarCutoffHour: EffectConfig.int("SOLAR_CUTOFF_HOUR").pipe(EffectConfig.withDefault(18)),
    deadlineHour: EffectConfig.int("DEADLINE_HOUR")
  },

  cost: {
    perKwh: EffectConfig.number("COST_PER_KWH").pipe(EffectConfig.withDefault(0.3))
  },

  httpApi: {
    port: EffectConfig.int("HTTP_API_PORT").pipe(EffectConfig.withDefault(8080))
  }
};
