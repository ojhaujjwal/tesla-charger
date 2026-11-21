import { describe, expect, it } from "@effect/vitest";
import { Cause, DateTime, Deferred, Duration, Effect, Exit, Fiber, Logger, PubSub, Ref } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { endSession, sleepUntilTimeOfDay } from "../../../application/session-lifecycle.js";
import {
  createInitialChargingControlState,
  createInitialChargingSessionStats,
  type ChargingControlState
} from "../../../domain/charging-session.js";
import { TimeOfDay } from "../../../domain/brands.js";
import type { TeslaChargerEvent } from "../../../domain/events.js";
import { DataAdapter } from "../../../data-adapter/types.js";
import { makeDataAdapterTest } from "../../fixtures/data-adapter.js";
import { makeTeslaClientTest } from "../../fixtures/tesla-client.js";

const utc = DateTime.zoneMakeOffset(0);

const startAt = (iso: string) => TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(iso)));

const forkShutdown = (time: TimeOfDay) =>
  Effect.gen(function* () {
    const stopped = yield* Ref.make(false);
    const effect = sleepUntilTimeOfDay(time, { zone: utc }).pipe(Effect.andThen(Ref.set(stopped, true)));
    const fiber = yield* effect.pipe(Effect.forkChild);
    return { stopped, fiber };
  });

describe("sleepUntilTimeOfDay", () => {
  it.effect("shuts down later on the same day", () =>
    Effect.gen(function* () {
      yield* startAt("2026-01-01T16:00:00Z");
      const { stopped, fiber } = yield* forkShutdown(TimeOfDay(17 * 60));

      yield* TestClock.adjust(Duration.minutes(59));
      expect(yield* Ref.get(stopped)).toBe(false);

      yield* TestClock.adjust(Duration.minutes(1));
      expect(yield* Ref.get(stopped)).toBe(true);

      yield* Fiber.join(fiber);
    })
  );

  it.effect("schedules the next day when the time has already passed", () =>
    Effect.gen(function* () {
      yield* startAt("2026-01-01T17:00:00Z");
      const { stopped, fiber } = yield* forkShutdown(TimeOfDay(16 * 60));

      yield* TestClock.adjust(Duration.minutes(22 * 60 + 59));
      expect(yield* Ref.get(stopped)).toBe(false);

      yield* TestClock.adjust(Duration.minutes(1));
      expect(yield* Ref.get(stopped)).toBe(true);

      yield* Fiber.join(fiber);
    })
  );

  it.effect("shuts down immediately when the time is now", () =>
    Effect.gen(function* () {
      yield* startAt("2026-01-01T17:00:00Z");
      const { stopped, fiber } = yield* forkShutdown(TimeOfDay(17 * 60));

      yield* TestClock.adjust(Duration.millis(0));
      expect(yield* Ref.get(stopped)).toBe(true);

      yield* Fiber.join(fiber);
    })
  );
});

describe("endSession flush", () => {
  // Generous upper bound in test-clock time: the flush deadline is seconds,
  // so reaching ten seconds of advances proves the flush stopped waiting.
  const advanceBudgetMs = 10_000;
  const advanceStepMs = 100;

  const endSessionWithStuckSubscriber = (pubSub: PubSub.PubSub<TeslaChargerEvent>) =>
    Effect.gen(function* () {
      const tesla = makeTeslaClientTest();
      const controlRef = yield* Ref.make<ChargingControlState>(createInitialChargingControlState());
      const statsRef = yield* Ref.make(createInitialChargingSessionStats());
      return yield* endSession({
        teslaClient: tesla.client,
        dataAdapter: yield* DataAdapter,
        controlRef,
        statsRef,
        pubSub,
        costPerKwh: 0.3,
        timingConfig: { syncIntervalInMs: 5000, vehicleAwakeningTimeInMs: 10000 },
        cycleInFlight: false
      });
    }).pipe(Effect.provide(makeDataAdapterTest({ latestValues: [{ daily_import: 0, voltage: 230 }] }).layer));

  it.effect("gives up flushing when a subscriber never pulls within the deadline", () =>
    Effect.gen(function* () {
      const pubSub = yield* PubSub.unbounded<TeslaChargerEvent>();
      // Subscribed but never takes: the SessionEnded message stays buffered.
      yield* PubSub.subscribe(pubSub);

      const warnings: Array<string> = [];
      const logger = Logger.make<unknown, void>((options) => {
        warnings.push(`[${options.logLevel}] ${options.message}`);
      });

      const stopFiber = yield* endSessionWithStuckSubscriber(pubSub).pipe(
        Effect.provide(Logger.layer([logger])),
        Effect.forkChild
      );

      let buffered = yield* PubSub.size(pubSub);
      while (buffered === 0) {
        yield* Effect.yieldNow;
        buffered = yield* PubSub.size(pubSub);
      }
      expect(buffered).toBe(1);

      let advancedMs = 0;
      while (stopFiber.pollUnsafe() === undefined && advancedMs < advanceBudgetMs) {
        yield* TestClock.adjust(Duration.millis(advanceStepMs));
        advancedMs += advanceStepMs;
      }

      expect(stopFiber.pollUnsafe()).toBeDefined();
      yield* Fiber.join(stopFiber);
      expect(warnings.some((warning) => warning.includes("session summary"))).toBe(true);
    })
  );
});

describe("flushPublishedEvents assumptions", () => {
  it.effect("shutdown drops messages subscribers have not pulled", () =>
    Effect.gen(function* () {
      const pubSub = yield* PubSub.unbounded<TeslaChargerEvent>();
      const subscription = yield* PubSub.subscribe(pubSub);

      yield* PubSub.publish(pubSub, { _tag: "ChargingStarted" });
      expect(yield* PubSub.size(pubSub)).toBe(1);

      yield* PubSub.shutdown(pubSub);

      const exit = yield* Effect.exit(PubSub.take(subscription));
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    })
  );

  it.effect("shutdown leaves a take that already pulled a message to complete", () =>
    Effect.gen(function* () {
      const pubSub = yield* PubSub.unbounded<TeslaChargerEvent>();
      const subscription = yield* PubSub.subscribe(pubSub);
      const processing = yield* Deferred.make<void>();
      const received = yield* Ref.make<Array<string>>([]);

      const subscriber = yield* Effect.gen(function* () {
        const event = yield* PubSub.take(subscription);
        yield* Deferred.await(processing);
        yield* Ref.update(received, (events) => [...events, event._tag]);
        yield* PubSub.take(subscription);
      }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* PubSub.publish(pubSub, { _tag: "ChargingStarted" });
      yield* PubSub.shutdown(pubSub);
      yield* Deferred.succeed(processing, undefined);

      const exit = yield* Fiber.await(subscriber);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(yield* Ref.get(received)).toEqual(["ChargingStarted"]);
    })
  );
});
