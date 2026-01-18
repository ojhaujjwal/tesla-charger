import { AuthenticationFailedError, ContextDeadlineExceededError, UnableToFetchAccessTokenError, VehicleAsleepError, VehicleCommandFailedError } from './errors.js';
import { Context, Duration, Effect, Layer, pipe, Schedule, Schema, Stream, String } from 'effect';
import { Command, CommandExecutor, FileSystem, HttpClient } from "@effect/platform";
import { raw } from '@effect/platform/HttpBody';
import { TeslaCachedTokenSchema, TeslaTokenResponseSchema, type TeslaTokenResponse } from './schema.js';


const OAUTH2_TOKEN_BASE_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';


type CommandResult = Effect.Effect<void, VehicleAsleepError | VehicleCommandFailedError>;

export type TeslaClient = {
  readonly authenticateFromAuthCodeGrant: (authorizationCode: string) => Effect.Effect<TeslaTokenResponse, unknown>;
  readonly refreshAccessToken: () => Effect.Effect<void, AuthenticationFailedError>;
  readonly setupAccessTokenAutoRefreshRecurring: (timeoutInSeconds: number) => Effect.Effect<Duration.Duration, AuthenticationFailedError>;
  readonly startCharging: () => CommandResult;
  readonly stopCharging: () => CommandResult;
  readonly setAmpere: (ampere: number) => CommandResult;
  readonly wakeUpCar: () => Effect.Effect<void, VehicleCommandFailedError>;
  readonly saveTokens: (accessToken: string, refreshToken: string) => Effect.Effect<void, unknown>;
}

export const TeslaClient = Context.GenericTag<TeslaClient>("@tesla-charger/TeslaClient");

// Helper function to collect stream output as a string
const runString = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>
): Effect.Effect<string, E, R> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(String.empty, String.concat)
  )

export const TeslaClientLayer = (config: {
  readonly appDomain: string;
  readonly clientId: string;
  readonly clientSecret: string;
}) => Layer.effect(
  TeslaClient,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const httpClient = yield* HttpClient.HttpClient;
    const commandExecutor = yield* CommandExecutor.CommandExecutor;

    const getTokens = () => Effect.gen(function* () {
      const json = yield* fs.readFileString('token.json');
      return yield* Schema.decodeUnknown(TeslaCachedTokenSchema)(JSON.parse(json));
    });

    const refreshAccessTokenFromTesla = () => Effect.gen(function* () {
      const { refresh_token } = yield* getTokens();

      const response = yield* httpClient.post(
        OAUTH2_TOKEN_BASE_URL,
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: raw(JSON.stringify({
            grant_type: "refresh_token",
            client_id: config.clientId,
            refresh_token: refresh_token,
          })),
        }
      );

      if (response.status !== 200) {
        return yield* Effect.fail(new UnableToFetchAccessTokenError());
      }

      return yield* Schema.decodeUnknown(TeslaTokenResponseSchema)(JSON.parse(yield* response.text));
    });

    const saveTokens = (accessToken: string, refreshToken: string) => Effect.gen(function* () {
      const encoded = JSON.stringify(yield* Schema.encode(TeslaCachedTokenSchema)({
        access_token: accessToken,
        refresh_token: refreshToken,
      }), null, 2);
      yield* fs.writeFileString('token.json', encoded);
      yield* fs.writeFileString('.access-token', accessToken);
    });

    const runCommand = (command: string, commandArgs: string[]) => Effect.gen(function* () {
      const process = yield* Command.start(Command.make(command, ...commandArgs));
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          process.exitCode,
          runString(process.stdout),
          runString(process.stderr)
        ],
        { concurrency: 3 }
      );
      return { exitCode, stdout, stderr };
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.succeed(CommandExecutor.CommandExecutor, commandExecutor))
    );

    const execTeslaControl = (commandArgs: string[]): Effect.Effect<void, VehicleAsleepError | VehicleCommandFailedError, never> => pipe(
      runCommand('tesla-control', commandArgs),
      Effect.tap(() => Effect.annotateCurrentSpan({
        command: commandArgs,
      })),
      Effect.withSpan('tesla-command'),
      Effect.flatMap(({ exitCode, stderr }): Effect.Effect<void, ContextDeadlineExceededError | VehicleCommandFailedError | VehicleAsleepError> => {
        if (exitCode === 0) return Effect.void;

        if (stderr.includes('vehicle is offline or asleep')) {
          return Effect.fail(new VehicleAsleepError());
        }
        if (stderr.includes('context deadline exceeded')) {
          return Effect.fail(new ContextDeadlineExceededError());
        }
        return Effect.fail(
          new VehicleCommandFailedError({ message: `Command failed. Stderr: ${stderr}`, stderr })
        );
      }),

      Effect.retry({
        schedule: Schedule.compose(
          Schedule.recurs(9),
          Schedule.exponential(Duration.seconds(0.1), 1.5)
        ),
        while: (error) => error._tag === "ContextDeadlineExceeded"
      }),

      Effect.catchTag("ContextDeadlineExceeded", () =>
        Effect.fail(new VehicleCommandFailedError({ message: "Command timed out after 10 attempts" }))
      ),
      Effect.catchTags({
        BadArgument: (error) => Effect.fail(
          new VehicleCommandFailedError({ message: `Execution failed: ${error.message}` })
        ),
        SystemError: (error) => Effect.fail(
          new VehicleCommandFailedError({ message: `Execution failed: ${error.message}` })
        ),
      }),
    );

    const refreshAccessToken = () => Effect.gen(function* () {
      const result = yield* refreshAccessTokenFromTesla();
      yield* saveTokens(result.access_token, result.refresh_token)
    }).pipe(
      Effect.catchAll((err) => Effect.fail(new AuthenticationFailedError({ previous: err }))),
    );

    return {
      authenticateFromAuthCodeGrant: (authorizationCode: string) => Effect.gen(function* () {
        const response = yield* httpClient.post(
          OAUTH2_TOKEN_BASE_URL,
          {
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: raw(JSON.stringify({
              grant_type: 'authorization_code',
              client_id: config.clientId,
              client_secret: config.clientSecret,
              audience: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
              redirect_uri: `https://${config.appDomain}/tesla-charger`,
              code: authorizationCode,
            })),
          }
        );

        return yield* Schema.decodeUnknown(TeslaTokenResponseSchema)(JSON.parse(yield* response.text));
      }),
      refreshAccessToken,
      setupAccessTokenAutoRefreshRecurring: (timeoutInSeconds: number) => Effect.repeat(refreshAccessToken(), {
        schedule: Schedule.duration(Duration.seconds(timeoutInSeconds)),
      }),
      startCharging: () => execTeslaControl(['charging-start']).pipe(
        Effect.catchTag('VehicleCommandFailed', (err) => {
          return err.stderr?.includes('car could not execute command: is_charging') ? Effect.void : Effect.fail(err);
        })
      ),
      stopCharging: () => execTeslaControl(['charging-stop']),
      setAmpere: (ampere: number) => execTeslaControl(['charging-set-amps', `${ampere}`]),
      wakeUpCar: () => execTeslaControl(['wake']).pipe(
        Effect.catchTag('VehicleAsleepError', () => Effect.fail(new VehicleCommandFailedError({ message: 'Vehicle is still asleep while issuing wakeup.' }))),
      ),
      saveTokens,
    };
  })
);
