import { AuthenticationFailedError, ContextDeadlineExceededError, UnableToFetchAccessTokenError, VehicleAsleepError, VehicleCommandFailedError } from './errors.js';
import { Duration, Effect, pipe, Schedule, Schema, Stream, String } from 'effect';
import { Command, FileSystem, HttpClient } from "@effect/platform";
import { NodeContext } from '@effect/platform-node';
import { raw } from '@effect/platform/HttpBody';
import { TeslaCachedTokenSchema, TeslaTokenResponseSchema, type TeslaTokenResponse } from './schema.js';


const OAUTH2_TOKEN_BASE_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';


type CommandResult = Effect.Effect<void, VehicleAsleepError | VehicleCommandFailedError>;

export type ITeslaClient = {
  authenticateFromAuthCodeGrant(authorizationCode: string): Effect.Effect<TeslaTokenResponse, unknown>;
  refreshAccessToken(): Effect.Effect<void, AuthenticationFailedError>;
  setupAccessTokenAutoRefreshRecurring(timeoutInSeconds: number): Effect.Effect<Duration.Duration, AuthenticationFailedError>;
  startCharging(): CommandResult;
  stopCharging(): CommandResult;
  setAmpere(ampere: number): CommandResult;
  wakeUpCar(): Effect.Effect<void, VehicleCommandFailedError>;
}

// Helper function to collect stream output as a string
const runString = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>
): Effect.Effect<string, E, R> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(String.empty, String.concat)
  )  

export class TeslaClient implements ITeslaClient {
  constructor(
    private appDomain: string,
    private clientId: string,
    private clientSecret: string,
    private fileSystem: FileSystem.FileSystem,
    private httpClient: HttpClient.HttpClient,
  ) { }

  private getTokens() {
    const fs = this.fileSystem;

    return Effect.gen(function*() {
       const json = yield* fs.readFileString('token.json');

       return yield* Schema.decodeUnknown(TeslaCachedTokenSchema)(JSON.parse(json));
    }).pipe();
  }
  
  public authenticateFromAuthCodeGrant(authorizationCode: string) {
    const deps = this;
    
    return Effect.gen(function*() {
      const response = yield* deps.httpClient.post(
        OAUTH2_TOKEN_BASE_URL,
        {
          headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',  
          },
          body: raw(JSON.stringify({
            grant_type: 'authorization_code',
            client_id: deps.clientId,
            client_secret: deps.clientSecret,
            audience: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
            redirect_uri: `https://${deps.appDomain}/tesla-charger`,
            code: authorizationCode,
          })),
        }
      );

      return yield* Schema.decodeUnknown(TeslaTokenResponseSchema)(JSON.parse(yield* response.text));
    });
  }

  private refreshAccessTokenFromTesla() { 
    const httpClient = this.httpClient;
    const clientId = this.clientId;
    const deps = this;
    
    return Effect.gen(function*() {
      const { refresh_token } = yield* deps.getTokens();

      const response = yield* httpClient.post(
        OAUTH2_TOKEN_BASE_URL,
        {
          headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',  
          },
          body: raw(JSON.stringify({
            grant_type: "refresh_token",
            client_id: clientId,
            refresh_token: refresh_token,
          })),
        }
      );

      if (response.status !== 200) {
        return yield* Effect.fail(new UnableToFetchAccessTokenError());
      }

      return yield* Schema.decodeUnknown(TeslaTokenResponseSchema)(JSON.parse(yield* response.text));
    });
  }

  public saveTokens(accessToken: string, refreshToken: string) {
    const fs = this.fileSystem;

    return Effect.gen(function*() {
      const encoded = JSON.stringify(yield* Schema.encode(TeslaCachedTokenSchema)({
        access_token: accessToken,
        refresh_token: refreshToken,
      }), null, 2);
      yield* fs.writeFileString('token.json', encoded);

      yield* fs.writeFileString('.access-token', accessToken);
    });
  }

  public setupAccessTokenAutoRefreshRecurring(timeoutInSeconds: number) {
    return Effect.repeat(this.refreshAccessToken(), {
      schedule: Schedule.duration(Duration.seconds(timeoutInSeconds)),
    });
  }

  public refreshAccessToken() {
    const deps = this;

    return Effect.gen(function*() {
      const result = yield* deps.refreshAccessTokenFromTesla();

      yield* deps.saveTokens(result.access_token, result.refresh_token)
    }).pipe(
      Effect.catchAll((err) => Effect.fail(new AuthenticationFailedError({ previous: err }))),
    );
  }


  public startCharging() {    
    return this.execTeslaControl(['charging-start'])
      .pipe(
        Effect.catchTag('VehicleCommandFailed', (err) => {
          return err.stderr?.includes('car could not execute command: is_charging') ? Effect.void : Effect.fail(err);
        })
      );

    //todo: assert that car is charging by calling API
  }

  public stopCharging(): CommandResult {
    return this.execTeslaControl(['charging-stop']);
    //todo: ignore if car is already not charging
  }

  public setAmpere(ampere: number): CommandResult {
    return this.execTeslaControl(['charging-set-amps', `${ampere}`]);
  }

  public wakeUpCar(): Effect.Effect<void, VehicleCommandFailedError> {
    return this.execTeslaControl(['wake']).pipe(
      Effect.catchTag('VehicleAsleepError', () => Effect.fail(new VehicleCommandFailedError({ message: 'Vehicle is still asleep while issuing wakeup.'}))),
    );
  }

  private execTeslaControl(commandArgs: string[]): Effect.Effect<void, VehicleAsleepError | VehicleCommandFailedError, never> {    
    return pipe(
      this.runCommand('tesla-control', commandArgs),
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
      
      // Retry logic for context deadline errors
      Effect.retry({
        schedule: Schedule.compose(
          Schedule.recurs(3),  // Max 3 retries (4 total attempts)
          Schedule.exponential(Duration.seconds(0.1), 1.5) // Backoff: 0.10s, 0.15s, 0.225s
        ),
        while: (error) => error._tag === "ContextDeadlineExceeded"
      }),

      // Convert retry exhaustion to permanent error
      Effect.catchTag("ContextDeadlineExceeded", () =>
        Effect.fail(new VehicleCommandFailedError({ message: "Command timed out after 4 attempts" }))
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
  }

  private runCommand(command: string, commandArgs: string[]) {
    return Effect.gen(function* () {
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
      Effect.provide(NodeContext.layer),
    );
  }
}
