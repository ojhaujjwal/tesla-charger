import { Duration, Effect, Layer, Redacted } from "effect";
import type { MockedObject } from "vitest";
import { vi } from "vitest";
import { TeslaClient, type TeslaClientService } from "../../tesla-client/index.js";
import { KiloWattHours as KWh, StateOfCharge } from "../../domain/brands.js";

export type TeslaClientTest = {
  readonly client: MockedObject<TeslaClientService>;
  readonly layer: Layer.Layer<TeslaClient>;
};

/**
 * A fresh Tesla client double per test, pre-loaded with happy-path answers.
 * Tests override individual methods on `client` before starting the code under
 * test, so one test's overrides never reach the next.
 */
export const makeTeslaClientTest = (): TeslaClientTest => {
  const client: MockedObject<TeslaClientService> = {
    authenticateFromAuthCodeGrant: vi.fn(),
    refreshAccessToken: vi.fn(),
    setupAccessTokenAutoRefreshRecurring: vi.fn(),
    startCharging: vi.fn(),
    stopCharging: vi.fn(),
    setAmpere: vi.fn(),
    setChargeLimit: vi.fn(),
    wakeUpCar: vi.fn(),
    getChargeState: vi.fn()
  };

  client.authenticateFromAuthCodeGrant.mockReturnValue(
    Effect.succeed({
      access_token: Redacted.make("access-token"),
      refresh_token: Redacted.make("refresh-token"),
      expires_in: 3600
    })
  );
  client.refreshAccessToken.mockReturnValue(Effect.void);
  client.setupAccessTokenAutoRefreshRecurring.mockReturnValue(Effect.succeed(Duration.seconds(1)));
  client.startCharging.mockReturnValue(Effect.void);
  client.stopCharging.mockReturnValue(Effect.void);
  client.setAmpere.mockReturnValue(Effect.void);
  client.setChargeLimit.mockReturnValue(Effect.void);
  client.wakeUpCar.mockReturnValue(Effect.void);
  client.getChargeState.mockReturnValue(
    Effect.succeed({
      batteryLevel: StateOfCharge(50),
      chargeLimitSoc: StateOfCharge(80),
      chargeEnergyAdded: KWh(0)
    })
  );

  return { client, layer: Layer.succeed(TeslaClient, client) };
};
