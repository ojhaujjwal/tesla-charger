import querystring from 'querystring';
import { TeslaClient } from './tesla-client/index.js';
import { Effect } from 'effect';
import { CommandExecutor, FileSystem, HttpClient } from '@effect/platform';
import { NodeContext, NodeHttpClient, NodeRuntime } from '@effect/platform-node';

const program = Effect.gen(function*() {
  const teslaClient = new TeslaClient(
    process.env.TESLA_APP_DOMAIN as string,
    process.env.TESLA_OAUTH2_CLIENT_ID as string,
    process.env.TESLA_OAUTH2_CLIENT_SECRET as string,
    yield* FileSystem.FileSystem,
    yield* HttpClient.HttpClient,
    yield* CommandExecutor.CommandExecutor,
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
          scope: "openid offline_access vehicle_location vehicle_c`harging_cmds vehicle_device_data vehicle_cmds",
          state,
          redirect_uri: `https://${process.env.TESLA_APP_DOMAIN}/tesla-charger`,
          locale: 'en-US',
          prompt: 'login'
        }),
    );

    return;
  }

  const result = yield* teslaClient.authenticateFromAuthCodeGrant(authorizationCode);

  yield* teslaClient.saveTokens(result.access_token, result.refresh_token);
});

NodeRuntime.runMain(program.pipe(
  Effect.provide(NodeContext.layer),
  Effect.provide(NodeHttpClient.layer),
));

