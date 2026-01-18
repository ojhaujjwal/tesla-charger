import { describe, it, vitest, beforeEach, expect } from "@effect/vitest";
import type { MockedObject } from "@effect/vitest";
import { Effect, Duration, Fiber, Layer } from "effect";
import { TeslaClient } from "../../tesla-client/index.js";
import { DataAdapter, type IDataAdapter } from "../../data-adapter/types.js";
import { ChargingSpeedController } from "../../charging-speed-controller/types.js";
import { App, AppLayer } from "../../app.js";

describe('App', () => {
    const teslaClientMock: MockedObject<TeslaClient> = {
        authenticateFromAuthCodeGrant: vitest.fn(),
        refreshAccessToken: vitest.fn(),
        setupAccessTokenAutoRefreshRecurring: vitest.fn(),
        startCharging: vitest.fn(),
        stopCharging: vitest.fn(),
        setAmpere: vitest.fn(),
        wakeUpCar: vitest.fn(),
        saveTokens: vitest.fn(),
    };

    const dataAdapterMock: MockedObject<IDataAdapter> = {
        queryLatestValues: vitest.fn(),
        getLowestValueInLastXMinutes: vitest.fn(),
    };

    const chargingSpeedControllerMock: MockedObject<ChargingSpeedController> = {
        determineChargingSpeed: vitest.fn(),
    };

    const TestTeslaClient = Layer.succeed(TeslaClient, teslaClientMock);
    const TestDataAdapter = Layer.succeed(DataAdapter, dataAdapterMock);
    const TestChargingSpeedController = Layer.succeed(ChargingSpeedController, chargingSpeedControllerMock);

    beforeEach(() => {
        vitest.clearAllMocks();
        // TeslaClient mocks
        teslaClientMock.authenticateFromAuthCodeGrant.mockReturnValue(
            Effect.succeed({
                access_token: "mockAccessToken",
                refresh_token: "mockRefreshToken",
                expires_in: 3600,
            })
        );
        teslaClientMock.refreshAccessToken.mockReturnValue(Effect.void);
        teslaClientMock.setupAccessTokenAutoRefreshRecurring.mockReturnValue(Effect.succeed(Duration.seconds(1)));
        teslaClientMock.startCharging.mockReturnValue(Effect.void);
        teslaClientMock.stopCharging.mockReturnValue(Effect.void);
        teslaClientMock.setAmpere.mockReturnValue(Effect.void);
        teslaClientMock.wakeUpCar.mockReturnValue(Effect.void);
        // DataAdapter mocks
        dataAdapterMock.queryLatestValues.mockReturnValue(Effect.succeed({ voltage: 230, current_production: 0, current_load: 0, daily_import: 0, export_to_grid: 0, import_from_grid: 0 }));
        dataAdapterMock.getLowestValueInLastXMinutes.mockReturnValue(Effect.succeed(0));
        // ChargingSpeedController mocks
        chargingSpeedControllerMock.determineChargingSpeed.mockReturnValue(Effect.succeed(10));
    })

    it.live('should authenticate and set up auto-refresh', () => Effect.gen(function* () {
        const app = yield* App;
        const fiber = yield* Effect.fork(app.start());
        yield* Effect.sleep(Duration.millis(100));
        expect(teslaClientMock.refreshAccessToken).toHaveBeenCalled();
        yield* Fiber.interrupt(fiber);
    }).pipe(
        Effect.provide(
            AppLayer({
                timingConfig: {
                    syncIntervalInMs: 50, // Fast for tests
                    vehicleAwakeningTimeInMs: 10,
                    inactivityTimeInSeconds: 15,
                    waitPerAmereInSeconds: 0.1,
                    extraWaitOnChargeStartInSeconds: 0.1,
                    extraWaitOnChargeStopInSeconds: 0.1,
                },
                isDryRun: false,
            }).pipe(
                Layer.provideMerge(TestChargingSpeedController),
                Layer.provideMerge(TestTeslaClient),
                Layer.provideMerge(TestDataAdapter)
            )
        )
    ));
});

