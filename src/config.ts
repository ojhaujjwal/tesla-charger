import { Config as EffectConfig } from "effect";


export const AppConfig = {
  tesla: {
    oauth2ClientId: EffectConfig.string("TESLA_OAUTH2_CLIENT_ID"),
    oauth2ClientSecret: EffectConfig.string("TESLA_OAUTH2_CLIENT_SECRET"),
  },

  influx: {
    url: EffectConfig.string("INFLUX_URL"),
    token: EffectConfig.string("INFLUX_TOKEN"),
    org: EffectConfig.string("INFLUX_ORG"),
    bucket: EffectConfig.string("INFLUX_BUCKET"),
  },
};
