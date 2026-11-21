import { describe, expect, it } from "@effect/vitest";
import { Cause, DateTime, Deferred, Duration, Effect, Exit, Fiber, PubSub, Ref } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { sleepUntilTimeOfDay } from "../../../application/session-lifecycle.js";
import { TimeOfDay } from "../../../domain/brands.js";
import type { TeslaChargerEvent } from "../../../domain/events.js";

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
