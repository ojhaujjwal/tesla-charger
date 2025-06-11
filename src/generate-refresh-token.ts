import querystring from 'querystring';
import { TeslaClient, TeslaTokenResponseSchema } from './tesla-client.js';
import { Effect, Schema } from 'effect';
import { FileSystem, HttpClient } from '@effect/platform';
import { NodeContext, NodeHttpClient, NodeRuntime } from '@effect/platform-node';

const program = Effect.gen(function*() {
  const teslaClient = new TeslaClient(
    process.env.TESLA_APP_DOMAIN as string,
    process.env.TESLA_OAUTH2_CLIENT_ID as string,
    process.env.TESLA_OAUTH2_CLIENT_SECRET as string,
    yield* FileSystem.FileSystem,
    yield* HttpClient.HttpClient,
  );

  const authorizationCode = process.argv[2] || null;

  // generate random string
  const state = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  
  if (authorizationCode === null) {
    console.log(
        'https://auth.tesla.com/oauth2/v3/authorize?' + 
        querystring.stringify({
          response_type: "code",
          client_id: process.env.TESLA_OAUTH2_CLIENT_ID,
          scope: "openid offline_access vehicle_location vehicle_charging_cmds vehicle_device_data vehicle_cmds",
          state,
          redirect_uri: `https://${process.env.TESLA_APP_DOMAIN}/tesla-charger`,
          locale: 'en-US',
          prompt: 'login'
        }),
    );

    const body = `
      {"access_token":"eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InFEc3NoM2FTV0cyT05YTTdLMzFWV0VVRW5BNCJ9.eyJpc3MiOiJodHRwczovL2ZsZWV0LWF1dGgudGVzbGEuY29tL29hdXRoMi92My9udHMiLCJhenAiOiI2OGEzNzc3MC03NDYzLTQ3ZDQtYWMwZS02YTRjZGFmOTlmZWUiLCJzdWIiOiIzODViNTI4MS1iMGU5LTQ4NGUtOTcxZi03ZmQ2YjI0YTAyNTQiLCJhdWQiOlsiaHR0cHM6Ly9mbGVldC1hcGkucHJkLm5hLnZuLmNsb3VkLnRlc2xhLmNvbSIsImh0dHBzOi8vZmxlZXQtYXBpLnByZC5ldS52bi5jbG91ZC50ZXNsYS5jb20iLCJodHRwczovL2ZsZWV0LWF1dGgudGVzbGEuY29tL29hdXRoMi92My91c2VyaW5mbyJdLCJzY3AiOlsib2ZmbGluZV9hY2Nlc3MiLCJ2ZWhpY2xlX2xvY2F0aW9uIiwidmVoaWNsZV9jaGFyZ2luZ19jbWRzIiwidmVoaWNsZV9kZXZpY2VfZGF0YSIsInZlaGljbGVfY21kcyIsIm9wZW5pZCJdLCJhbXIiOlsicHdkIiwibWZhIiwib3RwIl0sImV4cCI6MTc0OTQ5MDUzMCwiaWF0IjoxNzQ5NDYxNzMwLCJvdV9jb2RlIjoiTkEiLCJsb2NhbGUiOiJlbi1BVSIsImFjY291bnRfdHlwZSI6InBlcnNvbiIsIm9wZW5fc291cmNlIjpmYWxzZSwiYWNjb3VudF9pZCI6IjJhN2IwZmU4LWM3NTktNGQwNS1hYWE4LTkzZWZlOTFlMWRiOCIsImF1dGhfdGltZSI6MTc0OTQ2MTcwN30.ck1uiKtXAnvaCktEhXMwNuFBUyU3HQe8yFWtYFSZOW5wkcrfnJWIn1R-F_-vRsRTzV0KeW0vG5_1uk65FeNjO6zGRcSUb_vhG7QR6k6Y7Gosrk2SV_2mf12xTIUoXoaAtPIxzpvPjbAzhfJ8_c4tMk45b4e2jTg14YzHmXj6sSIZ9-efZ-gublLoHPhgLPeIzhWim_j_8fvfG9T16smJn_hbmsvcVjAtzensd1-VcljB6RIhmjxt6x0MTUR7-ExopCzesDl2riumzv3YPmbyaqPpFOiQKToAdgPns6_QAZ3kaOYTRxPWLFJYkZI40FGs5Kd6pTLij7gVfdm6mjlOaQ","refresh_token":"NA_8d0761d04afa9c0373e193fa02158898a8f873a3d2f4582fc5f9eae9c5668836","id_token":"eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InFEc3NoM2FTV0cyT05YTTdLMzFWV0VVRW5BNCJ9.eyJpc3MiOiJodHRwczovL2ZsZWV0LWF1dGgudGVzbGEuY29tL29hdXRoMi92My9udHMiLCJhdWQiOiI2OGEzNzc3MC03NDYzLTQ3ZDQtYWMwZS02YTRjZGFmOTlmZWUiLCJzdWIiOiIzODViNTI4MS1iMGU5LTQ4NGUtOTcxZi03ZmQ2YjI0YTAyNTQiLCJleHAiOjE3NDk0OTA1MzAsImlhdCI6MTc0OTQ2MTczMCwiYXV0aF90aW1lIjoxNzQ5NDYxNzA3LCJhbXIiOlsicHdkIiwibWZhIiwib3RwIl0sInVwZGF0ZWRfYXQiOjE3NDk0NjE3MzB9.V43a_cXc_yD1sRZX8Lqd6zIvJjpcZHAgFvhNCFgzftKLCZBBH76_GZ81GW2PxQ21pMWP2qxud1v1qetarODbuz08K467Ptvr2V0wvT9Mdi2q2aDYAKyWkkIfkIorLbW5vrf6nQg8SuAT8tDqgvOExKLI_3J0vf6vE1Y_jMkH1ZscauZGR1Tz9jTsE_Hb9c_qpTXtsC1kaiN4fu2Qct6FfV21I3MiWFhmWER40AhTeXXqiHlosrkNHRY4_ZyqTQuzk_NzLO3tkVtCxWMVFvweWNuy-6bbDd6H2XOedXjETCgStFOqcfgDXtptpzwsUXSNjpOjoigTYVt9oLHC60Oe1g","expires_in":28800,"state":"f8tw3vd0nbkk8qjkveozz","token_type":"Bearer"}
    `;

    console.log(yield* Schema.decodeUnknown(TeslaTokenResponseSchema)(JSON.parse(body)));

    return;
  }

  const result = yield* teslaClient.authenticateFromAuthCodeGrant(authorizationCode);

  yield* teslaClient.saveTokens(result.access_token, result.refresh_token);
});

NodeRuntime.runMain(program.pipe(
  Effect.provide(NodeContext.layer),
  Effect.provide(NodeHttpClient.layer),
));

