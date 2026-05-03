import { Config, Effect, Redacted } from "effect";

const clientId = Effect.runSync(Config.string("TESLA_OAUTH2_CLIENT_ID"));
const clientSecret = Effect.runSync(Config.redacted("TESLA_OAUTH2_CLIENT_SECRET"));
const appDomain = Effect.runSync(Config.string("TESLA_APP_DOMAIN"));

(async () => {
  // documented URI https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token
  const response = await fetch("https://auth.tesla.com/oauth2/v3/token", {
    method: "POST",
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: Redacted.value(clientSecret),
      audience: "https://fleet-api.prd.na.vn.cloud.tesla.com",
      scope: "openid offline_access vehicle_device_data vehicle_location vehicle_charging_cmds"
    }),
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    console.error(await response.json());
    return;
  }

  const { access_token } = await response.json();
  console.log(access_token);

  const response2 = await fetch("https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/partner_accounts", {
    method: "POST",
    body: JSON.stringify({
      domain: appDomain
    }),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${access_token}`
    }
  });

  console.log(await response2.json());
})();
