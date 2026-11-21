import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { TimeOfDay, TimeOfDayFromString } from "../../../domain/brands.js";

describe("TimeOfDayFromString", () => {
  const decode = Schema.decodeUnknownSync(TimeOfDayFromString);

  it("parses 24-hour times", () => {
    expect(decode("00:00")).toBe(TimeOfDay(0));
    expect(decode("05:30")).toBe(TimeOfDay(330));
    expect(decode("17:00")).toBe(TimeOfDay(1020));
    expect(decode("23:59")).toBe(TimeOfDay(1439));
  });

  it("parses 12-hour times", () => {
    expect(decode("5AM")).toBe(TimeOfDay(5 * 60));
    expect(decode("5PM")).toBe(TimeOfDay(17 * 60));
    expect(decode("5:30 PM")).toBe(TimeOfDay(17 * 60 + 30));
    expect(decode("12AM")).toBe(TimeOfDay(0));
    expect(decode("12PM")).toBe(TimeOfDay(12 * 60));
  });

  it("rejects invalid times", () => {
    expect(() => decode("24:00")).toThrow();
    expect(() => decode("17:60")).toThrow();
    expect(() => decode("13PM")).toThrow();
    expect(() => decode("not-a-time")).toThrow();
  });
});
