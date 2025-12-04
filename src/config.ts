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

  alphaEssAPI: {
    appId: EffectConfig.string("ALPHA_ESS_API_APP_ID"),
    appSecret: EffectConfig.string("ALPHA_ESS_API_APP_SECRET"),
    sysSn: EffectConfig.string("ALPHA_ESS_API_SYS_SN"),
    baseUrl: EffectConfig.string("ALPHA_ESS_API_BASE_URL").pipe(
      EffectConfig.withDefault("https://openapi.alphaess.com/")
    ),
  },
};
