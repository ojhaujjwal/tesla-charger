import { TeslaClient } from "./tesla-client/index.js";
import { DataNotAvailableError, SourceNotAvailableError, DataAdapter } from "./data-adapter/types.js";
import { type InadequateDataToDetermineSpeedError } from "./charging-speed-controller/types.js";
import { GridImportExhaustedError } from "./errors/grid-import-exhausted.error.js";
import { Context, Deferred, Effect, Exit, Fiber, FiberSet, Layer, Option, Ref, Scope } from "effect";
import type { AuthenticationFailedError, VehicleCommandFailedError } from "./tesla-client/errors.js";
import { VehicleNotWakingUpError } from "./errors/vehicle-not-waking-up.error.js";
import { BatteryStateManager } from "./battery-state-manager.js";
import { AppRuntime, AppStatus } from "./app-runtime.js";
import { TeslaChargerEventPubSub } from "./domain/events.js";
import type { ChargingConfig } from "./domain/charging-session.js";
import { ChargingSession } from "./domain/charging-session.js";
import type { TimeOfDay } from "./domain/brands.js";
import { beginSession, endSession, sleepUntilTimeOfDay } from "./application/session-lifecycle.js";

export type TimingConfig = {
  syncIntervalInMs: number;
  vehicleAwakeningTimeInMs: number;
  shutdownAt?: TimeOfDay;
};

export class App extends Context.Service<
  App,
  {
    readonly start: () => Effect.Effect<
      void,
      | AuthenticationFailedError
      | DataNotAvailableError
      | SourceNotAvailableError
      | InadequateDataToDetermineSpeedError
      | VehicleNotWakingUpError
      | VehicleCommandFailedError
      | GridImportExhaustedError
    >;
    readonly stop: () => Effect.Effect<void, never>;
  }
>()("@tesla-charger/App") {}

type Session = {
  readonly scope: Scope.Closeable;
  readonly fibers: FiberSet.FiberSet<unknown, unknown>;
  readonly syncFiber: Ref.Ref<Option.Option<Fiber.Fiber<unknown, unknown>>>;
};

export const AppLayer = (config: {
  readonly chargingConfig: ChargingConfig;
  readonly timingConfig: TimingConfig;
  readonly costPerKwh?: number;
  readonly forceChargeToHundredPercent?: boolean;
}) =>
  Layer.effect(
    App,
    Effect.gen(function* () {
      const teslaClient = yield* TeslaClient;
      const dataAdapter = yield* DataAdapter;
      const chargingSession = yield* ChargingSession;
      const batteryStateManager = yield* BatteryStateManager;
      const appRuntime = yield* AppRuntime;
      const pubSub = yield* TeslaChargerEventPubSub;
      const costPerKwh = config.costPerKwh ?? 0.3;

      const hasStoppedRef = yield* Ref.make(false);
      const sessionRef = yield* Ref.make<Option.Option<Session>>(Option.none());
      const cycleInFlightRef = yield* Ref.make(false);
      const stopped = yield* Deferred.make<void>();

      const stop = Effect.fn("stop")(
        function* () {
          const alreadyStopped = yield* Ref.getAndSet(hasStoppedRef, true);
          if (alreadyStopped) {
            // Another fiber owns the teardown; wait for it so the session
            // scope (and its subscribers) outlives the summary publish.
            yield* Deferred.await(stopped);
            return;
          }

          yield* Effect.gen(function* () {
            const session = yield* Ref.getAndSet(sessionRef, Option.none());

            if (Option.isSome(session)) {
              const syncFiber = yield* Ref.getAndSet(session.value.syncFiber, Option.none());
              if (Option.isSome(syncFiber)) {
                yield* Fiber.interrupt(syncFiber.value);
              }
            }

            yield* endSession({
              teslaClient,
              dataAdapter,
              controlRef: appRuntime.controlRef,
              statsRef: appRuntime.statsRef,
              pubSub,
              costPerKwh,
              timingConfig: config.timingConfig,
              cycleInFlight: yield* Ref.get(cycleInFlightRef)
            });

            if (Option.isSome(session)) {
              yield* FiberSet.awaitEmpty(session.value.fibers);
              yield* Scope.close(session.value.scope, Exit.void);
            }

            yield* Ref.set(appRuntime.appStatusRef, AppStatus.Stopped);
          }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined)));
        },
        (eff) => eff.pipe(Effect.orDie)
      );

      const start: App["Service"]["start"] = Effect.fn("start")(function* () {
        yield* Ref.set(appRuntime.appStatusRef, AppStatus.Running);

        const scope = yield* Scope.make();
        yield* Scope.use(
          Effect.gen(function* () {
            const fibers = yield* FiberSet.make();
            const syncFiber = yield* Ref.make(Option.none<Fiber.Fiber<unknown, unknown>>());
            yield* Ref.set(sessionRef, Option.some({ scope, fibers, syncFiber }));

            yield* beginSession(teslaClient, dataAdapter, batteryStateManager, appRuntime.statsRef, pubSub, fibers, {
              forceChargeToHundredPercent: config.forceChargeToHundredPercent ?? false
            });

            const runSyncCycle = Effect.fn("runSyncCycle", { root: true })(function* () {
              yield* Ref.set(cycleInFlightRef, true);

              const controlState = yield* Ref.get(appRuntime.controlRef);
              const sessionStats = yield* Ref.get(appRuntime.statsRef);

              const result = yield* chargingSession.runCycle(controlState, sessionStats);

              yield* Ref.set(appRuntime.controlRef, result.state);
              yield* Ref.set(appRuntime.statsRef, result.stats);
              yield* Ref.set(cycleInFlightRef, false);

              return result.outcome;
            });

            const mainSync = yield* Effect.repeat(runSyncCycle(), {
              while: (outcome) => outcome.status === "Running"
            }).pipe(Effect.forkScoped);
            yield* Ref.set(syncFiber, Option.some(mainSync));

            // End the session when the sync loop finishes on its own (for example,
            // the vehicle reaches its charge limit) or when SHUTDOWN_AT is reached.
            const shutdownAt = config.timingConfig.shutdownAt;
            yield* Effect.raceFirst(
              Fiber.join(mainSync),
              shutdownAt !== undefined ? sleepUntilTimeOfDay(shutdownAt) : Effect.never
            ).pipe(
              // Every exit tears the session down through the same path,
              // including terminal failures such as GridImportExhausted.
              Effect.onExit(() => stop())
            );
          }),
          scope
        );
      });

      return { start, stop };
    }).pipe(Effect.withSpan("AppLayer"))
  );
