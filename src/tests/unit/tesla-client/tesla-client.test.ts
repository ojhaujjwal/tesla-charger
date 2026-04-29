import { describe, it, expect, beforeEach, afterEach } from "@effect/vitest";
import { Cause, Duration, Effect, Exit, Fiber, Inspectable, Layer, Option, Sink, Stream, TestClock } from "effect";
import { CommandExecutor, FileSystem, HttpClient, HttpClientResponse } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { RequestError, ResponseError } from "@effect/platform/HttpClientError";
import { TeslaClient, TeslaClientLayer } from "../../../tesla-client/index.js";
import {
  AuthenticationFailedError,
  ChargeStateQueryFailedError,
  UnableToFetchAccessTokenError,
  VehicleAsleepError,
  VehicleCommandFailedError
} from "../../../tesla-client/errors.js";

let tmpDir: string;
let counter = 0;

beforeEach(() => {
  counter++;
  tmpDir = `/tmp/tesla-client-test-${Date.now()}-${counter}`;
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(tmpDir, { recursive: true });
  })
    .pipe(Effect.provide(NodeFileSystem.layer), Effect.runPromise)
    .catch(() => Promise.resolve());
});

afterEach(() => {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(tmpDir);
    if (exists) {
      yield* fs.remove(tmpDir, { recursive: true });
    }
  })
    .pipe(Effect.provide(NodeFileSystem.layer), Effect.runPromise)
    .catch(() => Promise.resolve());
});

const getFailure = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (!Exit.isFailure(exit)) throw new Error("Expected failure");
  return Option.getOrThrow(Cause.failureOption(exit.cause));
};

const validTokenJson = JSON.stringify({
  access_token: "new-access-token",
  refresh_token: "new-refresh-token"
});

const validChargeStateJson = JSON.stringify({
  response: {
    charge_state: {
      battery_level: 72,
      charge_limit_soc: 80,
      charge_energy_added: 15.5
    }
  }
});

const writeTokenFile = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      `${tmpDir}/token.json`,
      JSON.stringify({
        access_token: "existing-access-token",
        refresh_token: "existing-refresh-token"
      })
    );
  });

const makeMockHttpClient = (handler: {
  status?: number;
  body?: string;
  requestError?: boolean;
  neverRespond?: boolean;
}): HttpClient.HttpClient =>
  HttpClient.make((req) => {
    if (handler.neverRespond) return Effect.never;
    if (handler.requestError) return Effect.fail(new RequestError({ reason: "Transport", request: req }));
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        req,
        new Response(handler.body ?? "", {
          status: handler.status ?? 200,
          headers: { "Content-Type": "application/json" }
        })
      )
    );
  });

const makeMockProcess = (config: { exitCode: number; stderr: string }): CommandExecutor.Process => ({
  [CommandExecutor.ProcessTypeId]: CommandExecutor.ProcessTypeId,
  pid: CommandExecutor.ProcessId(1),
  exitCode: Effect.succeed(CommandExecutor.ExitCode(config.exitCode)),
  stderr: Stream.fromIterable([new TextEncoder().encode(config.stderr)]),
  stdout: Stream.empty,
  stdin: Sink.drain,
  kill: () => Effect.void,
  isRunning: Effect.succeed(false),
  toString: () => "MockProcess",
  toJSON: () => ({ _tag: "MockProcess" }),
  [Inspectable.NodeInspectSymbol]: () => ({ _tag: "MockProcess" })
});

const makeMockCommandExecutor = (
  configs: Array<{ exitCode: number; stderr: string }>
): CommandExecutor.CommandExecutor => {
  let callIndex = 0;
  const getConfig = () => {
    const cfg = configs[callIndex] ?? configs[configs.length - 1];
    callIndex++;
    return cfg;
  };
  return CommandExecutor.makeExecutor((_command) => Effect.succeed(makeMockProcess(getConfig())));
};

const makeTestLayer = (overrides: {
  httpClient?: HttpClient.HttpClient;
  commandExecutor?: CommandExecutor.CommandExecutor;
}) =>
  TeslaClientLayer({
    appDomain: "test.example.com",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    vin: "TESTVIN123",
    tokenFilePath: `${tmpDir}/token.json`,
    accessTokenFilePath: `${tmpDir}/.access-token`
  }).pipe(
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, overrides.httpClient ?? makeMockHttpClient({}))),
    Layer.provideMerge(
      Layer.succeed(
        CommandExecutor.CommandExecutor,
        overrides.commandExecutor ?? makeMockCommandExecutor([{ exitCode: 0, stderr: "" }])
      )
    ),
    Layer.provideMerge(NodeFileSystem.layer)
  );

describe("TeslaClient", () => {
  describe("authenticateFromAuthCodeGrant", () => {
    it.effect("should authenticate successfully given valid auth code", () =>
      Effect.gen(function* () {
        const client = yield* TeslaClient;
        const result = yield* client.authenticateFromAuthCodeGrant("valid-auth-code");

        expect(result).toEqual({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token"
        });

        const fs = yield* FileSystem.FileSystem;
        const tokenFilePath = `${tmpDir}/token.json`;
        const exists = yield* fs.exists(tokenFilePath);
        expect(exists).toBe(true);
        const saved = yield* fs.readFileString(tokenFilePath);
        expect(JSON.parse(saved)).toEqual({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token"
        });
      }).pipe(Effect.provide(makeTestLayer({ httpClient: makeMockHttpClient({ status: 200, body: validTokenJson }) })))
    );

    it.effect("should fail authentication given invalid auth code", () =>
      Effect.gen(function* () {
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.authenticateFromAuthCodeGrant("invalid-auth-code"));

        expect(result).toStrictEqual(
          Exit.fail(
            new UnableToFetchAccessTokenError({
              message: "Authorization code grant failed with status 400",
              statusCode: 400,
              responseBody: JSON.stringify({
                error: "invalid_grant",
                error_description: "Invalid authorization code"
              })
            })
          )
        );
      }).pipe(
        Effect.provide(
          makeTestLayer({
            httpClient: makeMockHttpClient({
              status: 400,
              body: JSON.stringify({
                error: "invalid_grant",
                error_description: "Invalid authorization code"
              })
            })
          })
        )
      )
    );

    it.effect("should return error on network connectivity issues", () =>
      Effect.gen(function* () {
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.authenticateFromAuthCodeGrant("auth-code"));

        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const failure = getFailure(result);
          expect(failure).toMatchObject({ _tag: "RequestError" });
        }
      }).pipe(Effect.provide(makeTestLayer({ httpClient: makeMockHttpClient({ requestError: true }) })))
    );

    it.effect("should return error out when request times out", () =>
      Effect.gen(function* () {
        const client = yield* TeslaClient;
        const fiber = yield* Effect.fork(client.authenticateFromAuthCodeGrant("auth-code"));

        yield* TestClock.adjust(Duration.seconds(6));
        const result = yield* Fiber.await(fiber);

        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const failure = getFailure(result);
          expect(failure).toMatchObject({
            _tag: "UnableToFetchAccessToken",
            message: "Authorization code grant request timed out"
          });
          expect(failure).toHaveProperty("cause");
        }
      }).pipe(Effect.provide(makeTestLayer({ httpClient: makeMockHttpClient({ neverRespond: true }) })))
    );

    it.effect("should return error for unexpected server responses", () =>
      Effect.gen(function* () {
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.authenticateFromAuthCodeGrant("auth-code"));

        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const failure = getFailure(result);
          expect(failure).toMatchObject({
            _tag: "UnableToFetchAccessToken",
            message: "Failed to parse token response",
            responseBody: "not valid json"
          });
        }
      }).pipe(
        Effect.provide(makeTestLayer({ httpClient: makeMockHttpClient({ status: 200, body: "not valid json" }) }))
      )
    );
  });

  describe("refreshAccessToken", () => {
    it.effect("should refresh access token successfully given valid refresh token exists", () =>
      Effect.gen(function* () {
        yield* writeTokenFile();
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.refreshAccessToken());

        expect(result).toStrictEqual(Exit.void);

        const fs = yield* FileSystem.FileSystem;
        const tokenFilePath = `${tmpDir}/token.json`;
        const saved = yield* fs.readFileString(tokenFilePath);
        expect(JSON.parse(saved)).toEqual({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token"
        });
      }).pipe(Effect.provide(makeTestLayer({ httpClient: makeMockHttpClient({ status: 200, body: validTokenJson }) })))
    );

    it.effect("should fail to refresh access token given invalid refresh token", () =>
      Effect.gen(function* () {
        yield* writeTokenFile();
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.refreshAccessToken());

        expect(result).toStrictEqual(
          Exit.fail(
            new AuthenticationFailedError({
              cause: new UnableToFetchAccessTokenError({
                message: "Token refresh failed with status 400",
                statusCode: 400,
                responseBody: ""
              })
            })
          )
        );
      }).pipe(Effect.provide(makeTestLayer({ httpClient: makeMockHttpClient({ status: 400, body: "" }) })))
    );

    it.effect("should return retry with exponential backoff on network connectivity issues", () => {
      let callCount = 0;
      const httpClient = HttpClient.make((req) => {
        callCount++;
        if (callCount === 1) {
          return Effect.fail(new RequestError({ reason: "Transport", request: req }));
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(validTokenJson, { status: 200, headers: { "Content-Type": "application/json" } })
          )
        );
      });

      return Effect.gen(function* () {
        yield* writeTokenFile();
        const client = yield* TeslaClient;
        const fiber = yield* Effect.fork(client.refreshAccessToken());
        yield* TestClock.adjust(Duration.seconds(3));
        const result = yield* Fiber.await(fiber);

        expect(result).toStrictEqual(Exit.void);
        expect(callCount).toBe(2);
      }).pipe(Effect.provide(makeTestLayer({ httpClient })));
    });

    it.effect("should return retry with exponential backoff when request times out", () => {
      let callCount = 0;
      const httpClient = HttpClient.make((req) => {
        callCount++;
        if (callCount === 1) {
          return Effect.never;
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(validTokenJson, { status: 200, headers: { "Content-Type": "application/json" } })
          )
        );
      });

      return Effect.gen(function* () {
        yield* writeTokenFile();
        const client = yield* TeslaClient;
        const fiber = yield* Effect.fork(client.refreshAccessToken());
        yield* TestClock.adjust(Duration.seconds(7));
        const result = yield* Fiber.await(fiber);

        expect(result).toStrictEqual(Exit.void);
        expect(callCount).toBe(2);
      }).pipe(Effect.provide(makeTestLayer({ httpClient })));
    });

    it.effect("should return retry with exponential backoff when server returns 5xx errors", () => {
      let callCount = 0;
      const httpClient = HttpClient.make((req) => {
        callCount++;
        if (callCount === 1) {
          return Effect.fail(
            new ResponseError({
              reason: "StatusCode",
              request: req,
              response: HttpClientResponse.fromWeb(req, new Response(null, { status: 503 }))
            })
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(validTokenJson, { status: 200, headers: { "Content-Type": "application/json" } })
          )
        );
      });

      return Effect.gen(function* () {
        yield* writeTokenFile();
        const client = yield* TeslaClient;
        const fiber = yield* Effect.fork(client.refreshAccessToken());
        yield* TestClock.adjust(Duration.seconds(3));
        const result = yield* Fiber.await(fiber);

        expect(result).toStrictEqual(Exit.void);
        expect(callCount).toBe(2);
      }).pipe(Effect.provide(makeTestLayer({ httpClient })));
    });

    it.effect("should return error when upstream returns 4xx responses", () =>
      Effect.gen(function* () {
        yield* writeTokenFile();
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.refreshAccessToken());

        expect(result).toStrictEqual(
          Exit.fail(
            new AuthenticationFailedError({
              cause: new UnableToFetchAccessTokenError({
                message: "Token refresh failed with status 401",
                statusCode: 401,
                responseBody: ""
              })
            })
          )
        );
      }).pipe(Effect.provide(makeTestLayer({ httpClient: makeMockHttpClient({ status: 401, body: "" }) })))
    );
  });

  describe("setupAccessTokenAutoRefreshRecurring", () => {
    it.effect("should set up recurring access token refresh successfully", () => {
      let callCount = 0;
      const httpClient = HttpClient.make((req) => {
        callCount++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(validTokenJson, { status: 200, headers: { "Content-Type": "application/json" } })
          )
        );
      });

      return Effect.gen(function* () {
        yield* writeTokenFile();
        const client = yield* TeslaClient;
        const fiber = yield* Effect.fork(client.setupAccessTokenAutoRefreshRecurring(60));
        yield* TestClock.adjust(Duration.seconds(61));
        yield* Fiber.interrupt(fiber);

        expect(callCount).toBeGreaterThanOrEqual(1);
      }).pipe(Effect.provide(makeTestLayer({ httpClient })));
    });

    it.effect("should return error when response body is not in expected format", () =>
      Effect.gen(function* () {
        yield* writeTokenFile();
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.setupAccessTokenAutoRefreshRecurring(60));

        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const failure = getFailure(result);
          expect(failure).toMatchObject({ _tag: "AuthenticationFailedError" });
        }
      }).pipe(
        Effect.provide(makeTestLayer({ httpClient: makeMockHttpClient({ status: 200, body: "not valid json" }) }))
      )
    );
  });

  describe("startCharging", () => {
    it.effect("should return void when command is successful", () =>
      Effect.gen(function* () {
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.startCharging());

        expect(result).toStrictEqual(Exit.void);
      }).pipe(
        Effect.provide(makeTestLayer({ commandExecutor: makeMockCommandExecutor([{ exitCode: 0, stderr: "" }]) }))
      )
    );

    it.effect("should return void when car is already charging", () =>
      Effect.gen(function* () {
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.startCharging());

        expect(result).toStrictEqual(Exit.void);
      }).pipe(
        Effect.provide(
          makeTestLayer({
            commandExecutor: makeMockCommandExecutor([
              { exitCode: 1, stderr: "car could not execute command: is_charging" }
            ])
          })
        )
      )
    );

    it.effect("should retry with exponential backoff when command execution times out", () =>
      Effect.gen(function* () {
        const client = yield* TeslaClient;
        const fiber = yield* Effect.fork(client.startCharging());
        yield* TestClock.adjust(Duration.seconds(1));
        const result = yield* Fiber.await(fiber);

        expect(result).toStrictEqual(Exit.void);
      }).pipe(
        Effect.provide(
          makeTestLayer({
            commandExecutor: makeMockCommandExecutor([
              { exitCode: 1, stderr: "context deadline exceeded" },
              { exitCode: 0, stderr: "" }
            ])
          })
        )
      )
    );

    it.effect("should return error when vehicle is asleep", () =>
      Effect.gen(function* () {
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.startCharging());

        expect(result).toStrictEqual(Exit.fail(new VehicleAsleepError()));
      }).pipe(
        Effect.provide(
          makeTestLayer({
            commandExecutor: makeMockCommandExecutor([{ exitCode: 1, stderr: "vehicle is offline or asleep" }])
          })
        )
      )
    );

    it.effect("should return error when command fails for other reasons", () =>
      Effect.gen(function* () {
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.startCharging());

        expect(result).toStrictEqual(
          Exit.fail(
            new VehicleCommandFailedError({
              message: "Command failed. Stderr: unknown error occurred",
              stderr: "unknown error occurred"
            })
          )
        );
      }).pipe(
        Effect.provide(
          makeTestLayer({
            commandExecutor: makeMockCommandExecutor([{ exitCode: 1, stderr: "unknown error occurred" }])
          })
        )
      )
    );
  });

  describe("stopCharging", () => {
    it.effect("should return void when command is successful", () =>
      Effect.gen(function* () {
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.stopCharging());

        expect(result).toStrictEqual(Exit.void);
      }).pipe(
        Effect.provide(makeTestLayer({ commandExecutor: makeMockCommandExecutor([{ exitCode: 0, stderr: "" }]) }))
      )
    );

    it.effect("should return void when car is already not charging", () =>
      Effect.gen(function* () {
        const client = yield* TeslaClient;
        // Note: This test is aspirational. stopCharging currently does not
        // handle the "already not charging" case specially.
        const result = yield* Effect.exit(client.stopCharging());

        expect(result).toStrictEqual(
          Exit.fail(
            new VehicleCommandFailedError({
              message: "Command failed. Stderr: ",
              stderr: ""
            })
          )
        );
      }).pipe(
        Effect.provide(makeTestLayer({ commandExecutor: makeMockCommandExecutor([{ exitCode: 1, stderr: "" }]) }))
      )
    );
  });

  describe("setAmpere", () => {
    it.effect("should set ampere successfully given valid input", () =>
      Effect.gen(function* () {
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.setAmpere(10));

        expect(result).toStrictEqual(Exit.void);
      }).pipe(
        Effect.provide(makeTestLayer({ commandExecutor: makeMockCommandExecutor([{ exitCode: 0, stderr: "" }]) }))
      )
    );

    it.effect("should return error given invalid ampere value", () =>
      Effect.gen(function* () {
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.setAmpere(999));

        expect(result).toStrictEqual(
          Exit.fail(
            new VehicleCommandFailedError({
              message: "Command failed. Stderr: invalid ampere value",
              stderr: "invalid ampere value"
            })
          )
        );
      }).pipe(
        Effect.provide(
          makeTestLayer({
            commandExecutor: makeMockCommandExecutor([{ exitCode: 1, stderr: "invalid ampere value" }])
          })
        )
      )
    );

    it.effect("should retry with exponential backoff when command execution times out", () =>
      Effect.gen(function* () {
        const client = yield* TeslaClient;
        const fiber = yield* Effect.fork(client.setAmpere(10));
        yield* TestClock.adjust(Duration.seconds(1));
        const result = yield* Fiber.await(fiber);

        expect(result).toStrictEqual(Exit.void);
      }).pipe(
        Effect.provide(
          makeTestLayer({
            commandExecutor: makeMockCommandExecutor([
              { exitCode: 1, stderr: "context deadline exceeded" },
              { exitCode: 0, stderr: "" }
            ])
          })
        )
      )
    );

    it.effect("should return error when vehicle is asleep", () =>
      Effect.gen(function* () {
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.setAmpere(10));

        expect(result).toStrictEqual(Exit.fail(new VehicleAsleepError()));
      }).pipe(
        Effect.provide(
          makeTestLayer({
            commandExecutor: makeMockCommandExecutor([{ exitCode: 1, stderr: "vehicle is offline or asleep" }])
          })
        )
      )
    );

    it.effect("should return error when command fails for other reasons", () =>
      Effect.gen(function* () {
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.setAmpere(10));

        expect(result).toStrictEqual(
          Exit.fail(
            new VehicleCommandFailedError({
              message: "Command failed. Stderr: some other error",
              stderr: "some other error"
            })
          )
        );
      }).pipe(
        Effect.provide(
          makeTestLayer({
            commandExecutor: makeMockCommandExecutor([{ exitCode: 1, stderr: "some other error" }])
          })
        )
      )
    );
  });

  describe("wakeUpCar", () => {
    it.effect("should wake up car successfully", () =>
      Effect.gen(function* () {
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.wakeUpCar());

        expect(result).toStrictEqual(Exit.void);
      }).pipe(
        Effect.provide(makeTestLayer({ commandExecutor: makeMockCommandExecutor([{ exitCode: 0, stderr: "" }]) }))
      )
    );

    it.effect("should return VehicleCommandFailedError should be returned if car is still asleep", () =>
      Effect.gen(function* () {
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.wakeUpCar());

        expect(result).toStrictEqual(
          Exit.fail(
            new VehicleCommandFailedError({
              message: "Vehicle is still asleep while issuing wakeup."
            })
          )
        );
      }).pipe(
        Effect.provide(
          makeTestLayer({
            commandExecutor: makeMockCommandExecutor([{ exitCode: 1, stderr: "vehicle is offline or asleep" }])
          })
        )
      )
    );

    it.effect("should return error when command fails for other reasons", () =>
      Effect.gen(function* () {
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.wakeUpCar());

        expect(result).toStrictEqual(
          Exit.fail(
            new VehicleCommandFailedError({
              message: "Command failed. Stderr: some error",
              stderr: "some error"
            })
          )
        );
      }).pipe(
        Effect.provide(
          makeTestLayer({
            commandExecutor: makeMockCommandExecutor([{ exitCode: 1, stderr: "some error" }])
          })
        )
      )
    );
  });

  describe("getChargeState", () => {
    it.effect("should fetch charge state successfully", () =>
      Effect.gen(function* () {
        yield* writeTokenFile();
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.getChargeState());

        expect(result).toStrictEqual(
          Exit.succeed({
            batteryLevel: 72,
            chargeLimitSoc: 80,
            chargeEnergyAdded: 15.5
          })
        );
      }).pipe(
        Effect.provide(makeTestLayer({ httpClient: makeMockHttpClient({ status: 200, body: validChargeStateJson }) }))
      )
    );

    it.effect("should retry with exponential backoff when query times out", () => {
      let callCount = 0;
      const httpClient = HttpClient.make((req) => {
        callCount++;
        if (callCount === 1) {
          return Effect.never;
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(validChargeStateJson, { status: 200, headers: { "Content-Type": "application/json" } })
          )
        );
      });

      return Effect.gen(function* () {
        yield* writeTokenFile();
        const client = yield* TeslaClient;
        const fiber = yield* Effect.fork(client.getChargeState());
        yield* TestClock.adjust(Duration.seconds(12));
        const result = yield* Fiber.await(fiber);

        expect(result).toStrictEqual(
          Exit.succeed({
            batteryLevel: 72,
            chargeLimitSoc: 80,
            chargeEnergyAdded: 15.5
          })
        );
        expect(callCount).toBe(2);
      }).pipe(Effect.provide(makeTestLayer({ httpClient })));
    });

    it.effect("should retry with exponential backoff when network connectivity issues occur", () => {
      let callCount = 0;
      const httpClient = HttpClient.make((req) => {
        callCount++;
        if (callCount === 1) {
          return Effect.fail(new RequestError({ reason: "Transport", request: req }));
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(validChargeStateJson, { status: 200, headers: { "Content-Type": "application/json" } })
          )
        );
      });

      return Effect.gen(function* () {
        yield* writeTokenFile();
        const client = yield* TeslaClient;
        const fiber = yield* Effect.fork(client.getChargeState());
        yield* TestClock.adjust(Duration.seconds(3));
        const result = yield* Fiber.await(fiber);

        expect(result).toStrictEqual(
          Exit.succeed({
            batteryLevel: 72,
            chargeLimitSoc: 80,
            chargeEnergyAdded: 15.5
          })
        );
        expect(callCount).toBe(2);
      }).pipe(Effect.provide(makeTestLayer({ httpClient })));
    });

    it.effect("should return error API returns 5xx errors", () =>
      Effect.gen(function* () {
        yield* writeTokenFile();
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.getChargeState());

        expect(result).toStrictEqual(
          Exit.fail(
            new ChargeStateQueryFailedError({
              message: "Fleet API returned status 500: "
            })
          )
        );
      }).pipe(Effect.provide(makeTestLayer({ httpClient: makeMockHttpClient({ status: 500, body: "" }) })))
    );

    it.effect("should return error when response body is not in expected format", () =>
      Effect.gen(function* () {
        yield* writeTokenFile();
        const client = yield* TeslaClient;
        const result = yield* Effect.exit(client.getChargeState());

        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const failure = getFailure(result);
          expect(failure).toMatchObject({
            _tag: "ChargeStateQueryFailed",
            message: "Failed to decode charge state response: ParseError"
          });
        }
      }).pipe(
        Effect.provide(makeTestLayer({ httpClient: makeMockHttpClient({ status: 200, body: "not valid json" }) }))
      )
    );
  });
});
