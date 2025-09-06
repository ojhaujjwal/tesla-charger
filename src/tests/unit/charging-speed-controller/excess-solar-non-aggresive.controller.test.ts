import { describe, it, expect, beforeEach } from "@effect/vitest";
import { vi } from "vitest";
import { type MockedObject } from "vitest";
import { ExcessSolarNonAggresiveController } from '../../../charging-speed-controller/excess-solar-non-aggresive.controller.js';
import { Effect } from "effect";
import { type ChargingSpeedController } from '../../../charging-speed-controller/types.js';

describe('ExcellSolarNonAggresiveController', () => {
  let mockBaseController: MockedObject<ChargingSpeedController>;
  let controller: ExcessSolarNonAggresiveController;

  beforeEach(() => {
    mockBaseController = {
      determineChargingSpeed: vi.fn(),
    };
    controller = new ExcessSolarNonAggresiveController(mockBaseController, { historyLength: 3 });
  });

  it.effect('should add only new values if different from last', () => Effect.gen(function*() {
    // Given
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(10));
    expect((yield* controller.determineChargingSpeed(0))).toBe(10);
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(10));
    expect((yield* controller.determineChargingSpeed(0))).toBe(10);

    // When
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(20));

    // Then
    expect((yield* controller.determineChargingSpeed(0))).toBe(10);
  }));

  it.effect('should use the minimum value from history', () => Effect.gen(function*() {
    // Given
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(15));

    // When
    expect((yield* controller.determineChargingSpeed(0))).toBe(15);

    // Given
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(8));

    // When
    expect((yield* controller.determineChargingSpeed(0))).toBe(8);

    // Given
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(12));

    // When
    expect((yield* controller.determineChargingSpeed(0))).toBe(8);

    // Given
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(20));
    // When
    expect((yield* controller.determineChargingSpeed(0))).toBe(8);
  }));

  it.effect('should only taken minimum from last X values', () => Effect.gen(function*() {
    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(5));
    expect((yield* controller.determineChargingSpeed(0))).toBe(5);

    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(10));
    expect((yield* controller.determineChargingSpeed(0))).toBe(5);

    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(8));
    expect((yield* controller.determineChargingSpeed(0))).toBe(5);

    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(12));
    expect((yield* controller.determineChargingSpeed(0))).toBe(8);

    mockBaseController.determineChargingSpeed.mockReturnValueOnce(Effect.succeed(15));
    expect((yield* controller.determineChargingSpeed(0))).toBe(8);
  }));
});
