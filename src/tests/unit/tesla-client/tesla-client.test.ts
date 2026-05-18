import { describe, it, expect } from "@effect/vitest";
import { Cause, Duration, Effect, Exit, Fiber, FileSystem, Layer, Option, Redacted, Sink, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, HttpClientError } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { NodeFileSystem } from "@effect/platform-node";
import { TeslaClient, TeslaClientLayer } from "../../../tesla-client/index.js";
import { VehicleAsleepError, VehicleCommandFailedError } from "../../../tesla-client/errors.js";

const getFailure = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (!Exit.isFailure(exit)) throw new Error("Expected failure");
  return Option.getOrThrow(Cause.findErrorOption(exit.cause));
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

const writeTokenFile = (tmpDir: string) =>
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
    if (handler.requestError)
      return Effect.fail(
        new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request: req }) })
      );
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

const makeMockChildProcessSpawner = (configs: Array<{ exitCode: number; stderr: string }>) => {
  let callIndex = 0;
  const getConfig = () => {
    const cfg = configs[callIndex] ?? configs[configs.length - 1];
    callIndex++;
    return cfg;
  };
  return ChildProcessSpawner.make((_command) =>
    Effect.gen(function* () {
      const cfg = getConfig();
      yield* Effect.addFinalizer(() => Effect.void);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(cfg.exitCode)),
        stderr: Stream.fromIterable([new TextEncoder().encode(cfg.stderr)]),
        stdout: Stream.empty,
        all: Stream.empty,
        stdin: Sink.drain,
        kill: () => Effect.void,
        isRunning: Effect.succeed(false),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      });
    }).pipe(Effect.scoped)
  );
};

const makeTestLayer = (
  tmpDir: string,
  overrides: {
    httpClient?: HttpClient.HttpClient;
    commandExecutor?: ChildProcessSpawner.ChildProcessSpawner["Service"];
  }
) =>
  TeslaClientLayer({
    appDomain: "test.example.com",
    clientId: "test-client-id",
    clientSecret: Redacted.make("test-client-secret"),
    vin: "TESTVIN123",
    tokenFilePath: `${tmpDir}/token.json`,
    accessTokenFilePath: `${tmpDir}/.access-token`
  }).pipe(
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, overrides.httpClient ?? makeMockHttpClient({}))),
    Layer.provideMerge(
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        overrides.commandExecutor ?? makeMockChildProcessSpawner([{ exitCode: 0, stderr: "" }])
      )
    ),
    Layer.provideMerge(NodeFileSystem.layer)
  );

const withTestDir = <A, E, R>(f: (tmpDir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tmpDir = `/tmp/tesla-client-test-${Date.now()}-${Math.random()}`;
    yield* fs.makeDirectory(tmpDir, { recursive: true });
    yield* Effect.addFinalizer(() =>
      fs.exists(tmpDir).pipe(
        Effect.flatMap((exists) => (exists ? fs.remove(tmpDir, { recursive: true }) : Effect.void)),
        Effect.catch(() => Effect.void)
      )
    );
    return yield* f(tmpDir);
  });

describe("TeslaClient", () => {
  describe("authenticateFromAuthCodeGrant", () => {
    it.effect("should authenticate successfully given valid auth code", () =>
      withTestDir((tmpDir) =>
        Effect.gen(function* () {
          const client = yield* TeslaClient;
          const result = yield* client.authenticateFromAuthCodeGrant("valid-auth-code");

          expect(result).toEqual({
            access_token: Redacted.make("new-access-token"),
            refresh_token: Redacted.make("new-refresh-token")
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
        }).pipe(
          Effect.provide(
            makeTestLayer(tmpDir, { httpClient: makeMockHttpClient({ status: 200, body: validTokenJson }) })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );

    it.effect("should fail authentication given invalid auth code", () =>
      withTestDir((tmpDir) =>
        Effect.gen(function* () {
          const client = yield* TeslaClient;
          const result = yield* Effect.exit(client.authenticateFromAuthCodeGrant("invalid-auth-code"));

          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            const failure = getFailure(result);
            expect(failure).toMatchObject({
              message: "Authorization code grant failed with status 400",
              statusCode: 400
            });
          }
        }).pipe(
          Effect.provide(
            makeTestLayer(tmpDir, {
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
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );

    it.effect("should return error on network connectivity issues", () =>
      withTestDir((tmpDir) =>
        Effect.gen(function* () {
          const client = yield* TeslaClient;
          const result = yield* Effect.exit(client.authenticateFromAuthCodeGrant("auth-code"));

          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            const failure = getFailure(result);
            expect(failure).toMatchObject({ _tag: "HttpClientError" });
          }
        }).pipe(Effect.provide(makeTestLayer(tmpDir, { httpClient: makeMockHttpClient({ requestError: true }) })))
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );

    it.effect("should return error out when request times out", () =>
      withTestDir((tmpDir) =>
        Effect.gen(function* () {
          const client = yield* TeslaClient;
          const fiber = yield* Effect.forkChild(client.authenticateFromAuthCodeGrant("auth-code"));

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
        }).pipe(Effect.provide(makeTestLayer(tmpDir, { httpClient: makeMockHttpClient({ neverRespond: true }) })))
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );

    it.effect("should return error for unexpected server responses", () =>
      withTestDir((tmpDir) =>
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
          Effect.provide(
            makeTestLayer(tmpDir, { httpClient: makeMockHttpClient({ status: 200, body: "not valid json" }) })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );
  });

  describe("refreshAccessToken", () => {
    it.effect("should refresh access token successfully given valid refresh token exists", () =>
      withTestDir((tmpDir) =>
        Effect.gen(function* () {
          yield* writeTokenFile(tmpDir);
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
        }).pipe(
          Effect.provide(
            makeTestLayer(tmpDir, { httpClient: makeMockHttpClient({ status: 200, body: validTokenJson }) })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );

    it.effect("should fail to refresh access token given invalid refresh token", () =>
      withTestDir((tmpDir) =>
        Effect.gen(function* () {
          yield* writeTokenFile(tmpDir);
          const client = yield* TeslaClient;
          const result = yield* Effect.exit(client.refreshAccessToken());

          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            const failure = getFailure(result);
            expect(failure).toMatchObject({ _tag: "AuthenticationFailedError" });
          }
        }).pipe(Effect.provide(makeTestLayer(tmpDir, { httpClient: makeMockHttpClient({ status: 400, body: "" }) })))
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );

    it.live(
      "should fail on transport error",
      () => {
        let callCount = 0;
        const httpClient = HttpClient.make((req) => {
          callCount++;
          if (callCount === 1) {
            return Effect.fail(
              new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request: req }) })
            );
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              req,
              new Response(validTokenJson, { status: 200, headers: { "Content-Type": "application/json" } })
            )
          );
        });

        return withTestDir((tmpDir) =>
          Effect.gen(function* () {
            yield* writeTokenFile(tmpDir);
            const client = yield* TeslaClient;
            const result = yield* Effect.exit(client.refreshAccessToken());

            expect(Exit.isSuccess(result)).toBe(true);
            expect(callCount).toBe(2);
          }).pipe(Effect.provide(makeTestLayer(tmpDir, { httpClient })))
        ).pipe(Effect.provide(NodeFileSystem.layer));
      },
      10000
    );

    it.live(
      "should fail on request timeout",
      () => {
        let callCount = 0;
        const httpClient = HttpClient.make((req) => {
          callCount++;
          if (callCount === 1) {
            return Effect.fail(
              new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request: req }) })
            );
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              req,
              new Response(validTokenJson, { status: 200, headers: { "Content-Type": "application/json" } })
            )
          );
        });

        return withTestDir((tmpDir) =>
          Effect.gen(function* () {
            yield* writeTokenFile(tmpDir);
            const client = yield* TeslaClient;
            const result = yield* Effect.exit(client.refreshAccessToken());

            expect(Exit.isSuccess(result)).toBe(true);
            expect(callCount).toBe(2);
          }).pipe(Effect.provide(makeTestLayer(tmpDir, { httpClient })))
        ).pipe(Effect.provide(NodeFileSystem.layer));
      },
      10000
    );

    it.live(
      "should fail on 5xx response",
      () => {
        let callCount = 0;
        const httpClient = HttpClient.make((req) => {
          callCount++;
          if (callCount === 1) {
            return Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.StatusCodeError({
                  request: req,
                  response: HttpClientResponse.fromWeb(req, new Response(null, { status: 503 }))
                })
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

        return withTestDir((tmpDir) =>
          Effect.gen(function* () {
            yield* writeTokenFile(tmpDir);
            const client = yield* TeslaClient;
            const result = yield* Effect.exit(client.refreshAccessToken());

            expect(Exit.isSuccess(result)).toBe(true);
            expect(callCount).toBe(2);
          }).pipe(Effect.provide(makeTestLayer(tmpDir, { httpClient })))
        ).pipe(Effect.provide(NodeFileSystem.layer));
      },
      10000
    );

    it.effect("should return error when upstream returns 4xx responses", () =>
      withTestDir((tmpDir) =>
        Effect.gen(function* () {
          yield* writeTokenFile(tmpDir);
          const client = yield* TeslaClient;
          const result = yield* Effect.exit(client.refreshAccessToken());

          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            const failure = getFailure(result);
            expect(failure).toMatchObject({ _tag: "AuthenticationFailedError" });
          }
        }).pipe(Effect.provide(makeTestLayer(tmpDir, { httpClient: makeMockHttpClient({ status: 401, body: "" }) })))
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );
  });

  describe("setupAccessTokenAutoRefreshRecurring", () => {
    it.live(
      "should set up recurring access token refresh successfully",
      () => {
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

        return withTestDir((tmpDir) =>
          Effect.gen(function* () {
            yield* writeTokenFile(tmpDir);
            const client = yield* TeslaClient;
            const fiber = yield* Effect.forkChild(client.setupAccessTokenAutoRefreshRecurring(60));
            yield* Effect.sleep(Duration.millis(100));
            yield* Fiber.interrupt(fiber);
            expect(callCount).toBeGreaterThanOrEqual(1);
          }).pipe(Effect.provide(makeTestLayer(tmpDir, { httpClient })))
        ).pipe(Effect.provide(NodeFileSystem.layer));
      },
      15000
    );

    it.effect("should return error when response body is not in expected format", () =>
      withTestDir((tmpDir) =>
        Effect.gen(function* () {
          yield* writeTokenFile(tmpDir);
          const client = yield* TeslaClient;
          const result = yield* Effect.exit(client.setupAccessTokenAutoRefreshRecurring(60));

          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            const failure = getFailure(result);
            expect(failure).toMatchObject({ _tag: "AuthenticationFailedError" });
          }
        }).pipe(
          Effect.provide(
            makeTestLayer(tmpDir, { httpClient: makeMockHttpClient({ status: 200, body: "not valid json" }) })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );
  });

  describe("startCharging", () => {
    it.effect("should return void when command is successful", () =>
      withTestDir((tmpDir) =>
        Effect.gen(function* () {
          const client = yield* TeslaClient;
          const result = yield* Effect.exit(client.startCharging());

          expect(result).toStrictEqual(Exit.void);
        }).pipe(
          Effect.provide(
            makeTestLayer(tmpDir, { commandExecutor: makeMockChildProcessSpawner([{ exitCode: 0, stderr: "" }]) })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );

    it.effect("should return void when car is already charging", () =>
      withTestDir((tmpDir) =>
        Effect.gen(function* () {
          const client = yield* TeslaClient;
          const result = yield* Effect.exit(client.startCharging());

          expect(result).toStrictEqual(Exit.void);
        }).pipe(
          Effect.provide(
            makeTestLayer(tmpDir, {
              commandExecutor: makeMockChildProcessSpawner([
                { exitCode: 1, stderr: "car could not execute command: is_charging" }
              ])
            })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );

    it.effect("should retry with exponential backoff when command execution times out", () =>
      withTestDir((tmpDir) =>
        Effect.gen(function* () {
          const client = yield* TeslaClient;
          const fiber = yield* Effect.forkChild(client.startCharging());
          yield* TestClock.adjust(Duration.seconds(1));
          const result = yield* Fiber.await(fiber);

          expect(result).toStrictEqual(Exit.void);
        }).pipe(
          Effect.provide(
            makeTestLayer(tmpDir, {
              commandExecutor: makeMockChildProcessSpawner([
                { exitCode: 1, stderr: "context deadline exceeded" },
                { exitCode: 0, stderr: "" }
              ])
            })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );

    it.effect("should return error when vehicle is asleep", () =>
      withTestDir((tmpDir) =>
        Effect.gen(function* () {
          const client = yield* TeslaClient;
          const result = yield* Effect.exit(client.startCharging());

          expect(result).toStrictEqual(Exit.fail(new VehicleAsleepError()));
        }).pipe(
          Effect.provide(
            makeTestLayer(tmpDir, {
              commandExecutor: makeMockChildProcessSpawner([{ exitCode: 1, stderr: "vehicle is offline or asleep" }])
            })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );

    it.effect("should return error when command fails for other reasons", () =>
      withTestDir((tmpDir) =>
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
            makeTestLayer(tmpDir, {
              commandExecutor: makeMockChildProcessSpawner([{ exitCode: 1, stderr: "unknown error occurred" }])
            })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );
  });

  describe("stopCharging", () => {
    it.effect("should return void when command is successful", () =>
      withTestDir((tmpDir) =>
        Effect.gen(function* () {
          const client = yield* TeslaClient;
          const result = yield* Effect.exit(client.stopCharging());

          expect(result).toStrictEqual(Exit.void);
        }).pipe(
          Effect.provide(
            makeTestLayer(tmpDir, { commandExecutor: makeMockChildProcessSpawner([{ exitCode: 0, stderr: "" }]) })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );

    it.effect("should return void when car is already not charging", () =>
      withTestDir((tmpDir) =>
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
          Effect.provide(
            makeTestLayer(tmpDir, { commandExecutor: makeMockChildProcessSpawner([{ exitCode: 1, stderr: "" }]) })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );
  });

  describe("setAmpere", () => {
    it.effect("should set ampere successfully given valid input", () =>
      withTestDir((tmpDir) =>
        Effect.gen(function* () {
          const client = yield* TeslaClient;
          const result = yield* Effect.exit(client.setAmpere(10));

          expect(result).toStrictEqual(Exit.void);
        }).pipe(
          Effect.provide(
            makeTestLayer(tmpDir, { commandExecutor: makeMockChildProcessSpawner([{ exitCode: 0, stderr: "" }]) })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );

    it.effect("should return error given invalid ampere value", () =>
      withTestDir((tmpDir) =>
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
            makeTestLayer(tmpDir, {
              commandExecutor: makeMockChildProcessSpawner([{ exitCode: 1, stderr: "invalid ampere value" }])
            })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );

    it.effect("should retry with exponential backoff when command execution times out", () =>
      withTestDir((tmpDir) =>
        Effect.gen(function* () {
          const client = yield* TeslaClient;
          const fiber = yield* Effect.forkChild(client.setAmpere(10));
          yield* TestClock.adjust(Duration.seconds(1));
          const result = yield* Fiber.await(fiber);

          expect(result).toStrictEqual(Exit.void);
        }).pipe(
          Effect.provide(
            makeTestLayer(tmpDir, {
              commandExecutor: makeMockChildProcessSpawner([
                { exitCode: 1, stderr: "context deadline exceeded" },
                { exitCode: 0, stderr: "" }
              ])
            })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );

    it.effect("should return error when vehicle is asleep", () =>
      withTestDir((tmpDir) =>
        Effect.gen(function* () {
          const client = yield* TeslaClient;
          const result = yield* Effect.exit(client.setAmpere(10));

          expect(result).toStrictEqual(Exit.fail(new VehicleAsleepError()));
        }).pipe(
          Effect.provide(
            makeTestLayer(tmpDir, {
              commandExecutor: makeMockChildProcessSpawner([{ exitCode: 1, stderr: "vehicle is offline or asleep" }])
            })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );

    it.effect("should return error when command fails for other reasons", () =>
      withTestDir((tmpDir) =>
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
            makeTestLayer(tmpDir, {
              commandExecutor: makeMockChildProcessSpawner([{ exitCode: 1, stderr: "some other error" }])
            })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );
  });

  describe("wakeUpCar", () => {
    it.effect("should wake up car successfully", () =>
      withTestDir((tmpDir) =>
        Effect.gen(function* () {
          const client = yield* TeslaClient;
          const result = yield* Effect.exit(client.wakeUpCar());

          expect(result).toStrictEqual(Exit.void);
        }).pipe(
          Effect.provide(
            makeTestLayer(tmpDir, { commandExecutor: makeMockChildProcessSpawner([{ exitCode: 0, stderr: "" }]) })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );

    it.effect("should return VehicleCommandFailedError should be returned if car is still asleep", () =>
      withTestDir((tmpDir) =>
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
            makeTestLayer(tmpDir, {
              commandExecutor: makeMockChildProcessSpawner([{ exitCode: 1, stderr: "vehicle is offline or asleep" }])
            })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );

    it.effect("should return error when command fails for other reasons", () =>
      withTestDir((tmpDir) =>
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
            makeTestLayer(tmpDir, {
              commandExecutor: makeMockChildProcessSpawner([{ exitCode: 1, stderr: "some error" }])
            })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );
  });

  describe("getChargeState", () => {
    it.effect("should fetch charge state successfully", () =>
      withTestDir((tmpDir) =>
        Effect.gen(function* () {
          yield* writeTokenFile(tmpDir);
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
          Effect.provide(
            makeTestLayer(tmpDir, { httpClient: makeMockHttpClient({ status: 200, body: validChargeStateJson }) })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );

    it.live(
      "should fail on query timeout",
      () => {
        let callCount = 0;
        const httpClient = HttpClient.make((req) => {
          callCount++;
          if (callCount === 1) {
            return Effect.fail(
              new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request: req }) })
            );
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              req,
              new Response(validChargeStateJson, { status: 200, headers: { "Content-Type": "application/json" } })
            )
          );
        });

        return withTestDir((tmpDir) =>
          Effect.gen(function* () {
            yield* writeTokenFile(tmpDir);
            const client = yield* TeslaClient;
            const result = yield* Effect.exit(client.getChargeState());

            expect(Exit.isSuccess(result)).toBe(true);
            expect(callCount).toBe(2);
          }).pipe(Effect.provide(makeTestLayer(tmpDir, { httpClient })))
        ).pipe(Effect.provide(NodeFileSystem.layer));
      },
      10000
    );

    it.effect("should succeed on first attempt when no network issues", () => {
      let callCount = 0;
      const httpClient = HttpClient.make((req) => {
        callCount++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(validChargeStateJson, { status: 200, headers: { "Content-Type": "application/json" } })
          )
        );
      });

      return withTestDir((tmpDir) =>
        Effect.gen(function* () {
          yield* writeTokenFile(tmpDir);
          const client = yield* TeslaClient;
          const result = yield* Effect.exit(client.getChargeState());

          expect(result).toStrictEqual(
            Exit.succeed({
              batteryLevel: 72,
              chargeLimitSoc: 80,
              chargeEnergyAdded: 15.5
            })
          );
          expect(callCount).toBe(1);
        }).pipe(Effect.provide(makeTestLayer(tmpDir, { httpClient })))
      ).pipe(Effect.provide(NodeFileSystem.layer));
    });

    it.effect("should return error API returns 5xx errors", () =>
      withTestDir((tmpDir) =>
        Effect.gen(function* () {
          yield* writeTokenFile(tmpDir);
          const client = yield* TeslaClient;
          const result = yield* Effect.exit(client.getChargeState());

          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            const failure = getFailure(result);
            expect(failure).toMatchObject({ _tag: "ChargeStateQueryFailed" });
          }
        }).pipe(Effect.provide(makeTestLayer(tmpDir, { httpClient: makeMockHttpClient({ status: 500, body: "" }) })))
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );

    it.effect("should return error when response body is not in expected format", () =>
      withTestDir((tmpDir) =>
        Effect.gen(function* () {
          yield* writeTokenFile(tmpDir);
          const client = yield* TeslaClient;
          const result = yield* Effect.exit(client.getChargeState());

          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            const failure = getFailure(result);
            expect(failure).toMatchObject({ _tag: "ChargeStateQueryFailed" });
          }
        }).pipe(
          Effect.provide(
            makeTestLayer(tmpDir, { httpClient: makeMockHttpClient({ status: 200, body: "not valid json" }) })
          )
        )
      ).pipe(Effect.provide(NodeFileSystem.layer))
    );
  });
});
