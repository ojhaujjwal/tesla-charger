import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ConservativeControllerLayer } from "../../../charging-speed-controller/conservative-controller.js";
import {
  ChargingSpeedController,
  InadequateDataToDetermineSpeedError
} from "../../../charging-speed-controller/types.js";
import { DataAdapter, DataNotAvailableError, SourceNotAvailableError } from "../../../data-adapter/types.js";
import { Ampere, Watt } from "../../../domain/brands.js";
import { makeDataAdapterTest, type DataAdapterResponse, type DataAdapterTest } from "../../fixtures/data-adapter.js";

const TestLayer = (dataAdapter: DataAdapterTest, bufferPower?: Watt) =>
  ConservativeControllerLayer(bufferPower === undefined ? {} : { bufferPower }).pipe(Layer.provide(dataAdapter.layer));

const scripted = (latestValues: ReadonlyArray<DataAdapterResponse>, lowestValue: number) =>
  makeDataAdapterTest({ latestValues, lowestValue });

describe("ConservativeController", () => {
  it.effect("derives the charging speed from the weakest solar production in the window", () => {
    const dataAdapter = scripted([{ voltage: 240, current_load: 500 }], 3000);

    return Effect.gen(function* () {
      const controller = yield* ChargingSpeedController;
      // floor((3000 - 500 + 8 * 240 - 100) / 240) = 18
      expect(yield* controller.determineChargingSpeed(Ampere(8))).toBe(Ampere(18));
    }).pipe(Effect.provide(TestLayer(dataAdapter)));
  });

  it.effect("clamps the derived speed to the maximum ampere", () => {
    const dataAdapter = scripted([{ voltage: 240, current_load: 0 }], 10000);

    return Effect.gen(function* () {
      const controller = yield* ChargingSpeedController;
      expect(yield* controller.determineChargingSpeed(Ampere(32))).toBe(Ampere(32));
    }).pipe(Effect.provide(TestLayer(dataAdapter)));
  });

  it.effect("clamps the derived speed to zero when consumption exceeds the weakest production", () => {
    const dataAdapter = scripted([{ voltage: 240, current_load: 1000 }], 0);

    return Effect.gen(function* () {
      const controller = yield* ChargingSpeedController;
      expect(yield* controller.determineChargingSpeed(Ampere(0))).toBe(Ampere(0));
    }).pipe(Effect.provide(TestLayer(dataAdapter)));
  });

  it.effect("subtracts the configured buffer power", () => {
    const dataAdapter = scripted([{ voltage: 240, current_load: 500 }], 3000);

    return Effect.gen(function* () {
      const controller = yield* ChargingSpeedController;
      // floor((3000 - 500 + 8 * 240 - 400) / 240) = 16
      expect(yield* controller.determineChargingSpeed(Ampere(8))).toBe(Ampere(16));
    }).pipe(Effect.provide(TestLayer(dataAdapter, Watt(400))));
  });

  it.effect("maps DataNotAvailable to InadequateDataToDetermineSpeedError", () => {
    const dataAdapter = scripted([{ failure: new DataNotAvailableError() }], 3000);

    return Effect.gen(function* () {
      const controller = yield* ChargingSpeedController;
      const error = yield* Effect.flip(controller.determineChargingSpeed(Ampere(8)));
      expect(error).toBeInstanceOf(InadequateDataToDetermineSpeedError);
      expect(error.cause).toBeInstanceOf(DataNotAvailableError);
    }).pipe(Effect.provide(TestLayer(dataAdapter)));
  });

  it.effect("maps SourceNotAvailable to InadequateDataToDetermineSpeedError", () => {
    const dataAdapter = scripted([{ failure: new SourceNotAvailableError() }], 3000);

    return Effect.gen(function* () {
      const controller = yield* ChargingSpeedController;
      const error = yield* Effect.flip(controller.determineChargingSpeed(Ampere(8)));
      expect(error).toBeInstanceOf(InadequateDataToDetermineSpeedError);
      expect(error.cause).toBeInstanceOf(SourceNotAvailableError);
    }).pipe(Effect.provide(TestLayer(dataAdapter)));
  });

  it.effect("the fixture fails loudly when a test reads an unscripted lowest value", () => {
    const dataAdapter = makeDataAdapterTest({ latestValues: [{ voltage: 240, current_load: 500 }] });

    return Effect.gen(function* () {
      const adapter = yield* DataAdapter;
      expect(() => adapter.getLowestValueInLastXMinutes("current_production", 30)).toThrow(
        'DataAdapter test script has no value for "lowestValue"'
      );
    }).pipe(Effect.provide(dataAdapter.layer));
  });
});
