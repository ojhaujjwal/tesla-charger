import { ElectricVehicle } from "../domain/electric-vehicle.js";
import type { Ampere } from "../domain/brands.js";
import {
  AuthenticationFailedError,
  ChargeStateQueryFailedError,
  ContextDeadlineExceededError,
  UnableToFetchAccessTokenError,
  VehicleAsleepError,
  VehicleCommandFailedError
} from "./errors.js";
import { Context, Duration, Effect, FileSystem, Layer, Redacted, Schedule, Schema, Stream, pipe } from "effect";
import { HttpClient, HttpBody, HttpClientError } from "effect/unstable/http";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  TeslaCachedTokenSchema,
  TeslaTokenResponseSchema,
  TeslaChargeStateResponseSchema,
  type TeslaTokenResponse
} from "./schema.js";

const OAUTH2_TOKEN_BASE_URL = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";
const FLEET_API_BASE_URL = "https://fleet-api.prd.na.vn.cloud.tesla.com";

type CommandResult = Effect.Effect<void, VehicleAsleepError | VehicleCommandFailedError>;

export type ChargeState = {
  readonly batteryLevel: number;
  readonly chargeLimitSoc: number;
  readonly chargeEnergyAdded: number;
};

export type TeslaClientService = ElectricVehicle["Service"] & {
  readonly authenticateFromAuthCodeGrant: (
    authorizationCode: string
  ) => Effect.Effect<
    TeslaTokenResponse,
    HttpClientError.HttpClientError | Schema.SchemaError | PlatformError | UnableToFetchAccessTokenError
  >;
  readonly refreshAccessToken: () => Effect.Effect<void, AuthenticationFailedError>;
  readonly setupAccessTokenAutoRefreshRecurring: (
    timeoutInSeconds: number
  ) => Effect.Effect<void, AuthenticationFailedError>;
  readonly startCharging: () => CommandResult;
  readonly stopCharging: () => CommandResult;
  readonly setAmpere: (ampere: Ampere) => CommandResult;
  readonly wakeUpCar: () => Effect.Effect<void, VehicleCommandFailedError>;
  readonly getChargeState: () => Effect.Effect<ChargeState, ChargeStateQueryFailedError>;
};

export class TeslaClient extends Context.Service<TeslaClient, TeslaClientService>()("@tesla-charger/TeslaClient") {}

// Helper function to collect stream output as a string
const runString = <E, R>(stream: Stream.Stream<Uint8Array, E, R>): Effect.Effect<string, E, R> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, s) => acc + s
    )
  );

export const TeslaClientLayer = (config: {
  readonly appDomain: string;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  readonly tokenFilePath?: string;
  readonly accessTokenFilePath?: string;
  readonly vin: string;
}) =>
  Layer.effect(
    TeslaClient,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const httpClient = yield* HttpClient.HttpClient;

      const getTokens = Effect.fn("getTokens")(function* () {
        const json = yield* fs.readFileString(config.tokenFilePath || "token.json");
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TeslaCachedTokenSchema))(json);
      });

      const refreshAccessTokenFromTesla = Effect.fn("refreshAccessTokenFromTesla")(function* () {
        const { refresh_token } = yield* getTokens();

        const response = yield* httpClient
          .post(OAUTH2_TOKEN_BASE_URL, {
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json"
            },
            body: HttpBody.raw(
              JSON.stringify({
                grant_type: "refresh_token",
                client_id: config.clientId,
                refresh_token: Redacted.value(refresh_token)
              })
            )
          })
          .pipe(
            Effect.timeout(Duration.seconds(5)),
            Effect.retry({
              schedule: Schedule.exponential(Duration.seconds(1), 2).pipe(Schedule.take(6)),
              while: (error) => error._tag === "HttpClientError" || error._tag === "TimeoutError"
            }),
            Effect.catchTag("TimeoutError", (err) =>
              Effect.fail(
                new UnableToFetchAccessTokenError({
                  message: "Request timed out after 5 seconds",
                  cause: err
                })
              )
            )
          );

        if (response.status !== 200) {
          const body = yield* response.text.pipe(Effect.catch(() => Effect.succeed("Unable to read response body")));
          return yield* new UnableToFetchAccessTokenError({
            message: `Token refresh failed with status ${response.status}`,
            statusCode: response.status,
            responseBody: body
          });
        }

        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TeslaTokenResponseSchema))(yield* response.text);
      });

      const saveTokens = (accessToken: Redacted.Redacted<string>, refreshToken: Redacted.Redacted<string>) =>
        Effect.gen(function* () {
          const encoded = JSON.stringify({
            access_token: Redacted.value(accessToken),
            refresh_token: Redacted.value(refreshToken)
          });
          yield* fs.writeFileString(config.tokenFilePath || "token.json", encoded);
          yield* fs.writeFileString(config.accessTokenFilePath || ".access-token", Redacted.value(accessToken));
        });

      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const runCommand = (command: string, commandArgs: string[]) =>
        Effect.gen(function* () {
          const cmd = ChildProcess.make(command, commandArgs);
          const handle = yield* childProcessSpawner.spawn(cmd);
          const [exitCode, stdout, stderr] = yield* Effect.all(
            [handle.exitCode, runString(handle.stdout), runString(handle.stderr)],
            { concurrency: 3 }
          );
          return { exitCode, stdout, stderr };
        }).pipe(Effect.scoped);

      const execTeslaControl = (commandArgs: string[]) =>
        pipe(
          runCommand("tesla-control", commandArgs),
          Effect.catch((error) =>
            Effect.fail(
              new VehicleCommandFailedError({
                message: `Execution failed: ${error?.message || String(error)}`,
                cause: error
              })
            )
          ),
          Effect.tap(() =>
            Effect.annotateCurrentSpan({
              command: commandArgs
            })
          ),
          Effect.withSpan("tesla-command"),
          Effect.flatMap(
            ({
              exitCode,
              stderr
            }): Effect.Effect<void, ContextDeadlineExceededError | VehicleCommandFailedError | VehicleAsleepError> => {
              if (exitCode === 0) return Effect.void;

              if (stderr.includes("vehicle is offline or asleep")) {
                return Effect.fail(new VehicleAsleepError());
              }
              if (stderr.includes("context deadline exceeded")) {
                return Effect.fail(new ContextDeadlineExceededError());
              }
              return Effect.fail(
                new VehicleCommandFailedError({ message: `Command failed. Stderr: ${stderr}`, stderr })
              );
            }
          ),

          Effect.retry({
            schedule: Schedule.exponential(Duration.seconds(0.1), 1.5).pipe(Schedule.take(10)),
            while: (error) => error._tag === "ContextDeadlineExceeded"
          }),

          Effect.catchTag("ContextDeadlineExceeded", () =>
            Effect.fail(new VehicleCommandFailedError({ message: "Command timed out after 10 attempts" }))
          )
        );

      const refreshAccessToken = () =>
        Effect.gen(function* () {
          const result = yield* refreshAccessTokenFromTesla();
          yield* saveTokens(result.access_token, result.refresh_token);
        }).pipe(
          Effect.mapError((err) => new AuthenticationFailedError({ cause: err })),
          Effect.withSpan("refreshAccessToken")
        );

      const getChargeState = Effect.fn("getChargeState")(function* () {
        const { access_token } = yield* getTokens().pipe(
          Effect.mapError(
            (err) =>
              new ChargeStateQueryFailedError({
                message: `Failed to get access token: ${err._tag}`,
                cause: err
              })
          )
        );

        const response = yield* httpClient
          .get(`${FLEET_API_BASE_URL}/api/1/vehicles/${config.vin}/vehicle_data?endpoints=charge_state`, {
            headers: {
              Authorization: `Bearer ${Redacted.value(access_token)}`,
              Accept: "application/json"
            }
          })
          .pipe(
            Effect.timeout(Duration.seconds(10)),
            Effect.retry({
              schedule: Schedule.exponential(Duration.seconds(1), 2).pipe(Schedule.take(4)),
              while: (error) => error._tag === "HttpClientError" || error._tag === "TimeoutError"
            }),
            Effect.mapError(
              (err) =>
                new ChargeStateQueryFailedError({
                  message: `Failed to query charge state: ${err._tag}`,
                  cause: err
                })
            )
          );

        if (response.status !== 200) {
          const errorText = yield* response.text.pipe(Effect.catch(() => Effect.succeed("Unknown error")));
          return yield* new ChargeStateQueryFailedError({
            message: `Fleet API returned status ${response.status}: ${errorText}`
          });
        }

        const responseBody = yield* response.text.pipe(
          Effect.mapError(
            (err) =>
              new ChargeStateQueryFailedError({
                message: `Failed to read response body: ${err._tag}`,
                cause: err
              })
          )
        );

        const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TeslaChargeStateResponseSchema))(
          responseBody
        ).pipe(
          Effect.mapError(
            (err) =>
              new ChargeStateQueryFailedError({
                message: `Failed to decode charge state response: ${err._tag}`,
                cause: err
              })
          )
        );

        return {
          batteryLevel: parsed.response.charge_state.battery_level,
          chargeLimitSoc: parsed.response.charge_state.charge_limit_soc,
          chargeEnergyAdded: parsed.response.charge_state.charge_energy_added
        };
      });

      const authenticateFromAuthCodeGrantInternal = Effect.fn("authenticateFromAuthCodeGrant")(function* (
        authorizationCode: string
      ) {
        const response = yield* httpClient
          .post(OAUTH2_TOKEN_BASE_URL, {
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json"
            },
            body: HttpBody.raw(
              JSON.stringify({
                grant_type: "authorization_code",
                client_id: config.clientId,
                client_secret: Redacted.value(config.clientSecret),
                audience: "https://fleet-api.prd.na.vn.cloud.tesla.com",
                redirect_uri: `https://${config.appDomain}/tesla-charger`,
                code: authorizationCode
              })
            )
          })
          .pipe(
            Effect.timeout(Duration.seconds(5)),
            Effect.catchTag("TimeoutError", (err) =>
              Effect.fail(
                new UnableToFetchAccessTokenError({
                  message: "Authorization code grant request timed out",
                  cause: err
                })
              )
            )
          );

        if (response.status !== 200) {
          return yield* new UnableToFetchAccessTokenError({
            message: `Authorization code grant failed with status ${response.status}`,
            statusCode: response.status,
            responseBody: yield* response.text
          });
        }

        const responseBody = yield* response.text;
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TeslaTokenResponseSchema))(responseBody).pipe(
          Effect.mapError(
            (err) =>
              new UnableToFetchAccessTokenError({
                message: "Failed to parse token response",
                cause: err,
                responseBody: responseBody
              })
          )
        );
      });

      return {
        authenticateFromAuthCodeGrant: (authorizationCode: string) =>
          authenticateFromAuthCodeGrantInternal(authorizationCode).pipe(
            Effect.flatMap((result) => saveTokens(result.access_token, result.refresh_token).pipe(Effect.as(result)))
          ),

        refreshAccessToken,
        setupAccessTokenAutoRefreshRecurring: (timeoutInSeconds: number) =>
          Effect.repeat(refreshAccessToken(), {
            schedule: Schedule.duration(Duration.seconds(timeoutInSeconds))
          }),
        startCharging: () =>
          execTeslaControl(["charging-start"]).pipe(
            Effect.catchTag("VehicleCommandFailed", (err) => {
              return err.stderr?.includes("car could not execute command: is_charging")
                ? Effect.void
                : Effect.fail(err);
            })
          ),
        stopCharging: () => execTeslaControl(["charging-stop"]),
        setAmpere: (ampere: Ampere) => execTeslaControl(["charging-set-amps", `${ampere}`]),
        wakeUpCar: () =>
          execTeslaControl(["wake"]).pipe(
            Effect.catchTag("VehicleAsleepError", () =>
              Effect.fail(new VehicleCommandFailedError({ message: "Vehicle is still asleep while issuing wakeup." }))
            )
          ),
        getChargeState
      };
    }).pipe(Effect.withSpan("TeslaClientLayer"))
  );
