import querystring from "querystring";
import { TeslaClient, TeslaClientLayer } from "./tesla-client/index.js";
import { Effect, Layer } from "effect";
import { NodeContext, NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { AppConfig } from "./config.js";

const program = Effect.gen(function* () {
  const teslaClient = yield* TeslaClient;

  const authorizationCode = process.argv[2] || null;

  // generate random string
  const state = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

  if (authorizationCode === null) {
    const clientId = yield* AppConfig.tesla.oauth2ClientId;
    const appDomain = yield* AppConfig.tesla.appDomain;

    yield* Effect.log(
      "https://auth.tesla.com/oauth2/v3/authorize?" +
        querystring.stringify({
          response_type: "code",
          client_id: clientId,
          scope: "openid offline_access vehicle_location vehicle_charging_cmds vehicle_device_data vehicle_cmds",
          state,
          redirect_uri: `https://${appDomain}/tesla-charger`,
          locale: "en-US",
          prompt: "login"
        })
    );

    return;
  }

  yield* teslaClient.authenticateFromAuthCodeGrant(authorizationCode);
});

const MainLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const appDomain = yield* AppConfig.tesla.appDomain;
    const clientId = yield* AppConfig.tesla.oauth2ClientId;
    const clientSecret = yield* AppConfig.tesla.oauth2ClientSecret;
    const vin = yield* AppConfig.tesla.vin;

    return TeslaClientLayer({
      appDomain,
      clientId,
      clientSecret,
      vin
    }).pipe(Layer.provide(NodeContext.layer), Layer.provide(NodeHttpClient.layer));
  })
);

NodeRuntime.runMain(program.pipe(Effect.provide(MainLayer), Effect.orDie));
