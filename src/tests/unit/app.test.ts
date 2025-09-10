import { describe, it, vitest, beforeEach, expect } from "@effect/vitest";
import type { MockedObject } from "@effect/vitest";
import { Effect, Duration, Fiber } from "effect";
import type { ITeslaClient } from "../../tesla-client/index.js";
import type { IDataAdapter } from "../../data-adapter/types.js";
import type { ChargingSpeedController } from "../../charging-speed-controller/types.js";
import type { IEventLogger } from "../../event-logger/types.js";
import { App } from "../../app.js";
import { sleep } from "effect/Clock";

describe('App', () => {
    const teslaClientMock: MockedObject<ITeslaClient> = {
        authenticateFromAuthCodeGrant: vitest.fn(),
        refreshAccessToken: vitest.fn(),
        setupAccessTokenAutoRefreshRecurring: vitest.fn(),
        startCharging: vitest.fn(),
        stopCharging: vitest.fn(),
        setAmpere: vitest.fn(),
        wakeUpCar: vitest.fn(),
    };

    const dataAdapterMock: MockedObject<IDataAdapter> = {
        queryLatestValues: vitest.fn(),
        getLowestValueInLastXMinutes: vitest.fn(),
    };

    const chargingSpeedControllerMock: MockedObject<ChargingSpeedController> = {
        determineChargingSpeed: vitest.fn(),
    };

    const eventLoggerMock: MockedObject<IEventLogger> = {
        onSetAmpere: vitest.fn(),
        onNoAmpereChange: vitest.fn(),
    };

    let app: App;


    beforeEach(() => {
        vitest.clearAllMocks();
        // TeslaClient mocks
        teslaClientMock.authenticateFromAuthCodeGrant.mockReturnValue(
            Effect.succeed({
                access_token: "mockAccessToken",
                refresh_token: "mockRefreshToken",
            })
        );
        teslaClientMock.refreshAccessToken.mockReturnValue(Effect.void);
        teslaClientMock.setupAccessTokenAutoRefreshRecurring.mockReturnValue(Effect.succeed(Duration.seconds(1)));
        teslaClientMock.startCharging.mockReturnValue(Effect.void);
        teslaClientMock.stopCharging.mockReturnValue(Effect.void);
        teslaClientMock.setAmpere.mockReturnValue(Effect.void);
        teslaClientMock.wakeUpCar.mockReturnValue(Effect.void);
        // IDataAdapter mocks
        dataAdapterMock.queryLatestValues.mockReturnValue(Effect.succeed({ voltage: 230, current_production: 0, current_load: 0, daily_import: 0, export_to_grid: 0, import_from_grid: 0 }));
        dataAdapterMock.getLowestValueInLastXMinutes.mockReturnValue(Effect.succeed(0));
        // ChargingSpeedController mocks
        chargingSpeedControllerMock.determineChargingSpeed.mockReturnValue(Effect.succeed(10));
        // IEventLogger mocks
        eventLoggerMock.onSetAmpere.mockReturnValue(Effect.void);
        eventLoggerMock.onNoAmpereChange.mockReturnValue(Effect.void);

        app = new App(
            teslaClientMock,
            dataAdapterMock,
            chargingSpeedControllerMock,
            false,
            eventLoggerMock
        );
    })
    
    it.live('should authenticate and set up auto-refresh', () => Effect.gen(function* () {
        const fiber = app.start().pipe(Effect.runFork);
        yield* sleep(100);
        expect(teslaClientMock.refreshAccessToken).toHaveBeenCalled();
        yield* Fiber.interrupt(fiber);
    }));
});

