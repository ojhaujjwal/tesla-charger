import { describe, expect, it } from "@effect/vitest";
import { DateTime, Duration, Effect, Fiber, Ref } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { sleepUntilTimeOfDay } from "../../../application/session-lifecycle.js";
import { TimeOfDay } from "../../../domain/brands.js";

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
