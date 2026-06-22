import { Config, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpBody } from "effect/unstable/http";
import { NodeServices, NodeHttpClient, NodeRuntime } from "@effect/platform-node";

const clientId = Effect.runSync(Config.string("TESLA_OAUTH2_CLIENT_ID"));
const clientSecret = Effect.runSync(Config.redacted("TESLA_OAUTH2_CLIENT_SECRET"));
const appDomain = Effect.runSync(Config.string("TESLA_APP_DOMAIN"));

const program = Effect.fn("setupTeslaPartnerApplication")(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  // documented URI https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token
  const response = yield* httpClient.post("https://auth.tesla.com/oauth2/v3/token", {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: HttpBody.raw(
      JSON.stringify({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: Redacted.value(clientSecret),
        audience: "https://fleet-api.prd.na.vn.cloud.tesla.com",
        scope: "openid offline_access vehicle_device_data vehicle_location vehicle_charging_cmds"
      })
    )
  });

  if (response.status !== 200) {
    const errorBody = yield* response.text.pipe(Effect.catch(() => Effect.succeed("Unable to read response body")));
    yield* Effect.logError(`Token request failed with status ${response.status}: ${errorBody}`);
    return;
  }

  const responseJson = yield* response.json;
  const TokenResponseSchema = Schema.Struct({ access_token: Schema.String });
  const { access_token: accessToken } = yield* Schema.decodeUnknownEffect(TokenResponseSchema)(responseJson).pipe(
    Effect.catch((err) => Effect.die(new Error(`Failed to decode token response: ${err.message}`)))
  );
  yield* Effect.logInfo(`Access token: ${accessToken}`);

  const response2 = yield* httpClient.post("https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/partner_accounts", {
    body: HttpBody.raw(
      JSON.stringify({
        domain: appDomain
      })
    ),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    }
  });

  const response2Json = yield* response2.json;
  yield* Effect.logInfo(JSON.stringify(response2Json));
});

NodeRuntime.runMain(program().pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerFetch))));
