import { describe, it, vitest, beforeEach, expect } from "@effect/vitest";
import type { MockedObject } from "@effect/vitest";
import { Effect, Duration, Fiber, Layer, TestClock, PubSub, Queue } from "effect";
import { TeslaClient } from "../../tesla-client/index.js";
import { VehicleAsleepError } from "../../tesla-client/errors.js";
import { DataAdapter, type IDataAdapter } from "../../data-adapter/types.js";
import { ChargingSpeedController } from "../../charging-speed-controller/types.js";
import { App, AppLayer, type TimingConfig } from "../../app.js";
import type { IEventLogger } from "../../event-logger/types.js";
import { BatteryStateManager, type BatteryState } from "../../battery-state-manager.js";
import type { TeslaChargerEvent } from "../../events.js";

describe('App', () => {
    const teslaClientMock: MockedObject<TeslaClient> = {
        authenticateFromAuthCodeGrant: vitest.fn(),
        refreshAccessToken: vitest.fn(),
        setupAccessTokenAutoRefreshRecurring: vitest.fn(),
        startCharging: vitest.fn(),
        stopCharging: vitest.fn(),
        setAmpere: vitest.fn(),
        wakeUpCar: vitest.fn(),
        getChargeState: vitest.fn(),
        saveTokens: vitest.fn(),
    };

    const dataAdapterMock: MockedObject<IDataAdapter> = {
        queryLatestValues: vitest.fn(),
        getLowestValueInLastXMinutes: vitest.fn(),
    };

    const chargingSpeedControllerMock: MockedObject<ChargingSpeedController['Type']> = {
        determineChargingSpeed: vitest.fn(),
    };

    const eventLoggerMock: MockedObject<IEventLogger> = {
        onSetAmpere: vitest.fn(),
        onNoAmpereChange: vitest.fn(),
        onSessionEnd: vitest.fn(),
    };

    let batteryState: BatteryState | null = null;
    const batteryStateManagerMock: MockedObject<BatteryStateManager> = {
        start: vitest.fn(),
        get: vitest.fn(() => batteryState),
    };

    const TestTeslaClient = Layer.succeed(TeslaClient, teslaClientMock);
    const TestDataAdapter = Layer.succeed(DataAdapter, dataAdapterMock);
    const TestChargingSpeedController = Layer.succeed(ChargingSpeedController, chargingSpeedControllerMock);
    const TestBatteryStateManager = Layer.succeed(BatteryStateManager, batteryStateManagerMock);

    const defaultTimingConfig: TimingConfig = {
        syncIntervalInMs: 5000,
        vehicleAwakeningTimeInMs: 10000,
        inactivityTimeInSeconds: 60,
        waitPerAmereInSeconds: 2,
        extraWaitOnChargeStartInSeconds: 10,
        extraWaitOnChargeStopInSeconds: 10,
    };

    const provideAppLayer = (appEffect: Effect.Effect<void, unknown, App>, timingConfig: TimingConfig = defaultTimingConfig) =>
        appEffect.pipe(
            Effect.provide(
                AppLayer({
                    timingConfig,
                    isDryRun: false,
                    eventLogger: eventLoggerMock,
                }).pipe(
                    Layer.provideMerge(TestBatteryStateManager),
                    Layer.provideMerge(TestChargingSpeedController),
                    Layer.provideMerge(TestTeslaClient),
                    Layer.provideMerge(TestDataAdapter)
                )
            )
        );

    beforeEach(() => {
        vitest.clearAllMocks();
        batteryState = null;
        // Default success mocks
        teslaClientMock.authenticateFromAuthCodeGrant.mockReturnValue(Effect.succeed({ access_token: "t", refresh_token: "r", expires_in: 3600 }));
        teslaClientMock.refreshAccessToken.mockReturnValue(Effect.void);
        teslaClientMock.setupAccessTokenAutoRefreshRecurring.mockReturnValue(Effect.succeed(Duration.seconds(1)));
        teslaClientMock.startCharging.mockReturnValue(Effect.void);
        teslaClientMock.stopCharging.mockReturnValue(Effect.void);
        teslaClientMock.setAmpere.mockReturnValue(Effect.void);
        teslaClientMock.wakeUpCar.mockReturnValue(Effect.void);
        teslaClientMock.getChargeState.mockReturnValue(Effect.succeed({ batteryLevel: 50, chargeLimitSoc: 80, chargeEnergyAdded: 0 }));

        dataAdapterMock.queryLatestValues.mockReturnValue(Effect.succeed({ voltage: 230, current_production: 5000, current_load: 0, daily_import: 0, export_to_grid: 5000, import_from_grid: 0 }));
        dataAdapterMock.getLowestValueInLastXMinutes.mockReturnValue(Effect.succeed(0));

        chargingSpeedControllerMock.determineChargingSpeed.mockReturnValue(Effect.succeed(10));

        eventLoggerMock.onSetAmpere.mockReturnValue(Effect.void);
        eventLoggerMock.onNoAmpereChange.mockReturnValue(Effect.void);
        eventLoggerMock.onSessionEnd.mockReturnValue(Effect.void);

        // Mock BatteryStateManager.start to return a no-op effect
        batteryStateManagerMock.start.mockImplementation(() => {
            return Effect.gen(function* () {
                yield* PubSub.unbounded();
                // Just wait forever - will be interrupted when app stops
                return yield* Effect.never;
            }).pipe(Effect.scoped);
        });
    });

    it.effect('should authenticate and set up auto-refresh', () => Effect.gen(function* () {
        const app = yield* App;
        const fiber = yield* Effect.fork(app.start());

        // Pass startup sleep (1000ms)
        yield* TestClock.adjust(Duration.seconds(1));

        // Pass sync interval (5s)
        yield* TestClock.adjust(Duration.seconds(6));

        expect(teslaClientMock.refreshAccessToken).toHaveBeenCalled();
        expect(teslaClientMock.setupAccessTokenAutoRefreshRecurring).toHaveBeenCalled();
        yield* Fiber.interrupt(fiber);
    }).pipe(provideAppLayer));

    it.effect('should start charging and set ampere when speed > 0', () => Effect.gen(function* () {
        const app = yield* App;
        const fiber = yield* Effect.fork(app.start());

        // Pass startup sleep
        yield* TestClock.adjust(Duration.seconds(1));

        // Pass loop time (Sync 5s + Wait 10s start + Amps wait ~20s) -> 30s is safe
        yield* TestClock.adjust(Duration.seconds(35));

        expect(teslaClientMock.startCharging).toHaveBeenCalled();
        expect(teslaClientMock.setAmpere).toHaveBeenCalledWith(10);
        expect(teslaClientMock.wakeUpCar).not.toHaveBeenCalled();

        yield* Fiber.interrupt(fiber);
    }).pipe(provideAppLayer));

    it.effect('should publish AmpereChanged event when ampere changes', () => Effect.gen(function* () {
        // Collect events published to the PubSub via the batteryStateManager mock
        const receivedEvents: TeslaChargerEvent[] = [];
        batteryStateManagerMock.start.mockImplementation((pubSub: PubSub.PubSub<TeslaChargerEvent>) =>
            Effect.gen(function* () {
                const dequeue = yield* PubSub.subscribe(pubSub);
                return yield* Queue.take(dequeue).pipe(
                    Effect.tap((event) => Effect.sync(() => { receivedEvents.push(event); })),
                    Effect.forever,
                );
            }).pipe(Effect.scoped)
        );

        const app = yield* App;
        const fiber = yield* Effect.fork(app.start());

        // Pass startup sleep
        yield* TestClock.adjust(Duration.seconds(1));

        // Pass loop time to trigger setAmpere(10) (0 -> 10)
        yield* TestClock.adjust(Duration.seconds(35));

        expect(teslaClientMock.setAmpere).toHaveBeenCalledWith(10);

        // Verify the AmpereChanged event was published
        expect(receivedEvents).toHaveLength(1);
        expect(receivedEvents[0]).toEqual({
            _tag: 'AmpereChanged',
            previous: 0,
            current: 10,
        });

        yield* Fiber.interrupt(fiber);
    }).pipe(provideAppLayer));

    it.effect('should not publish AmpereChanged event when ampere stays the same', () => Effect.gen(function* () {
        // Return same speed every iteration
        chargingSpeedControllerMock.determineChargingSpeed.mockReturnValue(Effect.succeed(10));

        const receivedEvents: TeslaChargerEvent[] = [];
        batteryStateManagerMock.start.mockImplementation((pubSub: PubSub.PubSub<TeslaChargerEvent>) =>
            Effect.gen(function* () {
                const dequeue = yield* PubSub.subscribe(pubSub);
                return yield* Queue.take(dequeue).pipe(
                    Effect.tap((event) => Effect.sync(() => { receivedEvents.push(event); })),
                    Effect.forever,
                );
            }).pipe(Effect.scoped)
        );

        const app = yield* App;
        const fiber = yield* Effect.fork(app.start());

        // Pass startup sleep
        yield* TestClock.adjust(Duration.seconds(1));

        // First iteration: 0 -> 10 (publishes event)
        yield* TestClock.adjust(Duration.seconds(35));
        expect(teslaClientMock.setAmpere).toHaveBeenCalledTimes(1);
        expect(receivedEvents).toHaveLength(1);

        // Second iteration: 10 -> 10 (no change, no event)
        yield* TestClock.adjust(Duration.seconds(10));

        // No new event should have been published
        expect(receivedEvents).toHaveLength(1);

        yield* Fiber.interrupt(fiber);
    }).pipe(provideAppLayer));

    it.effect('should stop charging when speed is too low (< 3)', () => Effect.gen(function* () {
        // Start with valid speed to get it running
        let iteration = 0;
        chargingSpeedControllerMock.determineChargingSpeed.mockImplementation(() => {
            iteration++;
            if (iteration === 1) return Effect.succeed(10); // Start
            return Effect.succeed(0); // Stop
        });

        const app = yield* App;
        const fiber = yield* Effect.fork(app.start());

        // Pass startup
        yield* TestClock.adjust(Duration.seconds(1));

        // Iteration 1 (Start) - 10A. Wait ~30s total.
        yield* TestClock.adjust(Duration.seconds(35));
        expect(teslaClientMock.startCharging).toHaveBeenCalled();

        // Iteration 2 (Stop) - 0A. Wait ~15s total (extraWaitOnChargeStopInSeconds=10 + sync=5)
        yield* TestClock.adjust(Duration.seconds(20));

        expect(teslaClientMock.stopCharging).toHaveBeenCalled();

        yield* Fiber.interrupt(fiber);
    }).pipe(provideAppLayer));

    it.effect('should retry on VehicleAsleepError and wake up car', () => Effect.gen(function* () {
        // Mock setAmpere to fail with VehicleAsleepError once
        let called = false;
        teslaClientMock.setAmpere.mockImplementation(() => Effect.suspend(() => {
            if (!called) {
                called = true;
                return Effect.fail(new VehicleAsleepError());
            }
            return Effect.void;
        }));

        const app = yield* App;
        const fiber = yield* Effect.fork(app.start());

        // Pass startup
        yield* TestClock.adjust(Duration.seconds(1));

        // Pass loop
        yield* TestClock.adjust(Duration.seconds(60));

        // We need to advance enough for the retry sleep (vehicleAwakeningTimeInMs = 10000ms)
        yield* TestClock.adjust(Duration.seconds(15));

        expect(teslaClientMock.wakeUpCar).toHaveBeenCalled();
        expect(teslaClientMock.setAmpere).toHaveBeenCalledTimes(2); // Failed once, succeded once

        yield* Fiber.interrupt(fiber);
    }).pipe(provideAppLayer));

    it.effect('should handle AbruptProductionDropError by retrying', () => Effect.gen(function* () {
        // Setup scenarios:
        // 1. Initial stable state (6A)
        // 2. Increase to 10A -> triggers watch
        // 3. During watch (wait phase), grid import detected -> AbruptProductionDropError
        // 4. Retry -> 8A based on the latest data

        let iteration = 0;
        chargingSpeedControllerMock.determineChargingSpeed.mockImplementation(() => {
            iteration++;
            if (iteration <= 2) return Effect.succeed(6);
            if (iteration == 3) return Effect.succeed(10);
            return Effect.succeed(8);
        });

        // Dynamic Data Adapter Mock
        let simulateGridImport = false;
        const goodResponse = { current_production: 5000, import_from_grid: 0, voltage: 230, current_load: 0, daily_import: 0, export_to_grid: 0 };
        const badResponse = { current_production: 1000, import_from_grid: 500, daily_import: 200, voltage: 230, current_load: 0, export_to_grid: 0 }; // Import!

        dataAdapterMock.queryLatestValues.mockImplementation(() => {
            if (simulateGridImport) {
                return Effect.succeed(badResponse);
            }
            return Effect.succeed(goodResponse);
        });

        const app = yield* App;
        const fiber = yield* Effect.fork(app.start());

        // Pass startup (1s)
        yield* TestClock.adjust(Duration.seconds(2));

        // Loop 1 (6A) - Starts at T=2s? No, T=1s relative to test start?
        // App starts. T=0.
        // Startup delay? None/Small? We removed config `initialStartupDelay`.
        // So syncChargingRate starts immediately.
        // Iter 1 (6A). SetAmpere at ~0s.
        // Wait (6-0)*2 + 10 = 22s.
        // Sync 5s.
        // Loop 1 ends at ~27s. Loop 2 sets ampere at ~27s.

        // Advance a bit to catch First Call (SetAmpere 6A)
        yield* TestClock.adjust(Duration.seconds(5)); // T=7s. In Wait Phase of Loop 1.

        expect(teslaClientMock.setAmpere).toHaveBeenCalledTimes(1);
        expect(teslaClientMock.setAmpere).toHaveBeenLastCalledWith(6);

        // Loop 2 (6A).
        // Iterate past Loop 1 end (27s).
        // Advance 25s. T=32s.
        // Loop 2 started at 27s. Determine(6).
        // 6 == chargeState.ampere (6). setAmpere skipped.
        // Loop 2 duration: 5s (0 wait + 5 sync). Ends at 32s.
        yield* TestClock.adjust(Duration.seconds(25));

        expect(teslaClientMock.setAmpere).toHaveBeenCalledTimes(1); // Unchanged
        expect(teslaClientMock.setAmpere).toHaveBeenLastCalledWith(6);

        // Loop 3 (10A).
        // Starts at ~32s. SetAmpere(10) at ~32s.
        // Advance 2s to catch it. T=34s.
        yield* TestClock.adjust(Duration.seconds(2));

        expect(teslaClientMock.setAmpere).toHaveBeenCalledTimes(2); // +1 Call
        expect(teslaClientMock.setAmpere).toHaveBeenLastCalledWith(10);

        // Turn on bad data
        simulateGridImport = true;

        // Advance 5s. Watcher triggers AbruptDrop.
        yield* TestClock.adjust(Duration.seconds(5));

        // Simulate recovery
        simulateGridImport = false;

        // Advance enough for Loop 4 to process (Retry + New Loop)
        yield* TestClock.adjust(Duration.seconds(10));

        expect(chargingSpeedControllerMock.determineChargingSpeed).toHaveBeenCalledTimes(4); // 6, 6, 10, 8
        expect(teslaClientMock.setAmpere).toHaveBeenCalledTimes(3); // 6, 10, 8 (Loop 2 skipped)
        expect(teslaClientMock.setAmpere).toHaveBeenLastCalledWith(8);

        const status = yield* Fiber.status(fiber);
        expect(status._tag).not.toBe('Done'); // Still running

        yield* Fiber.interrupt(fiber);
    }).pipe(provideAppLayer));

    it.effect('should stop charging when battery level reaches charge limit', () => Effect.gen(function* () {
        // Mock battery state manager to return completed charge
        batteryState = {
            batteryLevel: 80,
            chargeLimitSoc: 80,
            queriedAtMs: Date.now(),
        };

        // Ensure charging is active - keep returning 10A so charging stays active
        chargingSpeedControllerMock.determineChargingSpeed.mockReturnValue(Effect.succeed(10));
        
        // Return different values for different calls to queryLatestValues
        let callCount = 0;
        dataAdapterMock.queryLatestValues.mockImplementation(() => {
            callCount++;
            // First call: initial daily_import query
            // Second call: syncAmpere queries current_production
            // Third+ calls: checkIfCorrectlyCharging queries current_load and voltage
            if (callCount <= 2) {
                return Effect.succeed({ 
                    voltage: 230, 
                    current_production: 5000, 
                    current_load: 0, 
                    daily_import: 0, 
                    export_to_grid: 5000, 
                    import_from_grid: 0 
                });
            }
            // Subsequent calls - charging state (for checkIfCorrectlyCharging)
            // current_load = 10A * 230V = 2300W to simulate active charging
            return Effect.succeed({ 
                voltage: 230, 
                current_production: 5000, 
                current_load: 2300, // Simulate charging load (10A * 230V)
                daily_import: 0, 
                export_to_grid: 5000, 
                import_from_grid: 0 
            });
        });

        const app = yield* App;
        const fiber = yield* Effect.fork(app.start());

        // Pass startup sleep (1s)
        yield* TestClock.adjust(Duration.seconds(1));

        // First iteration: startCharging + setAmpere(10) + wait (~30s) + sync interval (5s)
        // Total: ~35s for first iteration to complete, which includes checkIfCorrectlyCharging
        yield* TestClock.adjust(Duration.seconds(40));
        
        expect(teslaClientMock.startCharging).toHaveBeenCalled();
        expect(teslaClientMock.setAmpere).toHaveBeenCalledWith(10);
        
        // Wait a bit more to ensure stop() completes and stopChargingAction() is called
        yield* TestClock.adjust(Duration.seconds(1));
        
        // Should stop charging when complete
        expect(teslaClientMock.stopCharging).toHaveBeenCalled();

        yield* Fiber.interrupt(fiber);
    }).pipe(provideAppLayer));

    it.effect('should call onSessionEnd with summary when stop() is called', () => Effect.gen(function* () {
        // Setup charging speed to change multiple times to test ampereFluctuations
        let iteration = 0;
        chargingSpeedControllerMock.determineChargingSpeed.mockImplementation(() => {
            iteration++;
            if (iteration === 1) return Effect.succeed(6);
            if (iteration === 2) return Effect.succeed(10);
            if (iteration === 3) return Effect.succeed(15);
            return Effect.succeed(15);
        });

        // Mock getChargeState for start() and stop()
        let getChargeStateCallCount = 0;
        teslaClientMock.getChargeState.mockImplementation(() => {
            getChargeStateCallCount++;
            if (getChargeStateCallCount === 1) {
                // Initial call in start()
                return Effect.succeed({ batteryLevel: 50, chargeLimitSoc: 80, chargeEnergyAdded: 0 });
            }
            // Final call in stop()
            return Effect.succeed({ batteryLevel: 60, chargeLimitSoc: 80, chargeEnergyAdded: 5.5 });
        });

        // Mock queryLatestValues for start(), sync cycles, and stop()
        let queryLatestValuesCallCount = 0;
        dataAdapterMock.queryLatestValues.mockImplementation(() => {
            queryLatestValuesCallCount++;
            if (queryLatestValuesCallCount === 1) {
                // Initial call in start() for daily_import
                return Effect.succeed({ daily_import: 0, voltage: 230, current_production: 5000, current_load: 0, export_to_grid: 5000, import_from_grid: 0 });
            }
            // Calls during sync cycles for current_production
            if (queryLatestValuesCallCount <= 5) {
                return Effect.succeed({ current_production: 5000, voltage: 230, current_load: 0, daily_import: 0, export_to_grid: 5000, import_from_grid: 0 });
            }
            // Final call in stop() for daily_import and voltage
            return Effect.succeed({ daily_import: 2.0, voltage: 230, current_production: 5000, current_load: 0, export_to_grid: 5000, import_from_grid: 0 });
        });

        const app = yield* App;
        const fiber = yield* Effect.fork(app.start());

        // Pass startup
        yield* TestClock.adjust(Duration.seconds(1));

        // First iteration: setAmpere(6) - 0 -> 6 = 1 fluctuation
        yield* TestClock.adjust(Duration.seconds(30));
        expect(teslaClientMock.setAmpere).toHaveBeenCalledWith(6);

        // Second iteration: setAmpere(10) - 6 -> 10 = 1 fluctuation (total: 2)
        yield* TestClock.adjust(Duration.seconds(30));
        expect(teslaClientMock.setAmpere).toHaveBeenCalledWith(10);

        // Third iteration: setAmpere(15) - 10 -> 15 = 1 fluctuation (total: 3)
        yield* TestClock.adjust(Duration.seconds(30));
        expect(teslaClientMock.setAmpere).toHaveBeenCalledWith(15);

        // Fourth iteration: no change (15 == 15) - should NOT increment fluctuations
        yield* TestClock.adjust(Duration.seconds(10));
        expect(teslaClientMock.setAmpere).toHaveBeenCalledTimes(3); // Still 3 calls

        // Stop the app
        yield* app.stop();

        // Verify onSessionEnd was called with expected summary including correct ampereFluctuations
        expect(eventLoggerMock.onSessionEnd).toHaveBeenCalledTimes(1);
        const summary = eventLoggerMock.onSessionEnd.mock.calls[0][0];
        expect(summary).toMatchObject({
            sessionDurationMs: expect.any(Number),
            totalEnergyChargedKwh: 5.5, // 5.5 - 0
            gridImportKwh: 2.0, // 2.0 - 0
            solarEnergyUsedKwh: 3.5, // 5.5 - 2.0
            averageChargingSpeedAmps: expect.any(Number),
            ampereFluctuations: 3, // 0->6, 6->10, 10->15 = 3 fluctuations
            gridImportCost: expect.any(Number),
        });

        yield* Fiber.interrupt(fiber);
    }).pipe(provideAppLayer));
});
