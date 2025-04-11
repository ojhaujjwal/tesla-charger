import { App } from '../../app.js';
import type { ITeslaClient } from '../../tesla-client.js';
import type { IDataAdapter } from '../../data-adapter/types.js';
import type { ChargingSpeedController } from '../../charging-speed-controller/types.js';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi, afterEach } from 'vitest';
import type { MockedObject } from 'vitest';
import { VehicleAsleepError } from '../../errors/vehicle-asleep-error.js';
import 'p-retry';
import { pino } from 'pino';
import * as pinoTest from 'pino-test';

vi.mock('p-retry', () => {
  return {
    default: async (
      fn: () => Promise<unknown>, options: {
        retries: number;
        onFailedAttempt?: (error: unknown) => Promise<void>;
        shouldRetry: (error: unknown) => boolean,
      }
    ) => {
      let attempts = 0;
      const maxAttempts = options.retries + 1;
      
      while (attempts < maxAttempts) {
        try {
          return await fn();
        } catch (error) {
          attempts++;
          
          if (options.onFailedAttempt) {
            await options.onFailedAttempt(error as Error);
          }

          if (!options.shouldRetry(error) || attempts >= maxAttempts) {
            throw error;
          }
        }
      }
      throw new Error('Max retries reached');
    }
  };
});

const mockedTeslaClient: MockedObject<ITeslaClient> = {
  setupAccessTokenAutoRefresh: vi.fn().mockReturnValue(() => {
    // do nothing.
  }),
  wakeUpCar: vi.fn().mockReturnValue(Promise.resolve()),
  startCharging: vi.fn().mockReturnValue(Promise.resolve()),
  stopCharging: vi.fn().mockReturnValue(Promise.resolve()),
  setAmpere: vi.fn().mockReturnValue(Promise.resolve()),
  authenticateFromAuthCodeGrant: vi.fn(),
};

const mockedDataAdapter: MockedObject<IDataAdapter<unknown>> = {
  authenticate: vi.fn(),
  getDailyImportValue: vi.fn().mockResolvedValue(0),
  getCurrentProduction: vi.fn().mockResolvedValue(1000),
  getValues: vi.fn(),
  getVoltage: vi.fn(),
  getLowestValueInLastXMinutes: vi.fn(),
};

const mockedChargingSpeedController: MockedObject<ChargingSpeedController> = {
  determineChargingSpeed: vi.fn(),
};

const loggerStream = pinoTest.sink()
const logger = pino(loggerStream);
const eventLogger = {
  onSetAmpere: vi.fn(),
  onNoAmpereChange: vi.fn(),
};

describe('App', () => {
  let app: App;

  beforeAll(() => {
    vi.useFakeTimers();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  describe('start', () => {
    beforeEach(() => {
      // Reset mocks before each test
      vi.clearAllMocks();
      //vi.setSystemTime(new Date());
  
      app = new App(
        mockedTeslaClient, 
        mockedDataAdapter, 
        mockedChargingSpeedController, 
        false,
        logger,
        eventLogger,
        {
          syncIntervalInMs: 1000,
          vehicleAwakeningTimeInMs: 10,
          inactivityTimeInSeconds: 0.01,
          waitPerAmereInSeconds: 0.002, // 2ms
          extraWaitOnChargeStartInSeconds: 0.001,
          extraWaitOnChargeStopInSeconds: 0.0001,
        },
      );
    });

    afterEach(async () => {
      await app.stop();
    });

    it('should not start charging if ampere is less than 5', async () => {
      mockedChargingSpeedController.determineChargingSpeed.mockResolvedValue(3);
      
      await app.start();

      vi.advanceTimersByTime(11 * 1000);

      expect(mockedTeslaClient.startCharging).not.toHaveBeenCalled();
      expect(mockedTeslaClient.setAmpere).not.toHaveBeenCalled();
    });

    it('should not wake up car and start charging if ampere is greater than 5 and vehicle is not asleep', async () => {
      mockedChargingSpeedController.determineChargingSpeed.mockResolvedValue(10);
      
      await app.start();

      vi.advanceTimersByTime(100);

      expect(mockedTeslaClient.wakeUpCar).not.toHaveBeenCalled();
      expect(mockedTeslaClient.startCharging).toHaveBeenCalledOnce();
      expect(mockedTeslaClient.setAmpere).toHaveBeenNthCalledWith(1, 10);
      //expect(mockedTeslaClient.setAmpere).toHaveBeenNthCalledWith(2, 15);
    });

    it('should wake up car and start charging if ampere >= 5 and vehicle is asleep.', async () => {
      mockedChargingSpeedController.determineChargingSpeed.mockResolvedValue(10);

      mockedTeslaClient.startCharging.mockRejectedValueOnce(new VehicleAsleepError());
      mockedTeslaClient.startCharging.mockResolvedValueOnce();
      
      await app.start();
      vi.advanceTimersByTime(2 * 1000);

      await app.stop();

      expect(mockedTeslaClient.wakeUpCar).toHaveBeenCalledOnce();
      expect(mockedTeslaClient.startCharging).toHaveBeenCalledTimes(2);
      expect(mockedTeslaClient.setAmpere).toHaveBeenNthCalledWith(1, 10);
    });

    it('should not change ampere if it is matched with the last sync', async () => {
      mockedChargingSpeedController.determineChargingSpeed.mockResolvedValue(10);
      await app.start();

      vi.advanceTimersByTime(2 * 1000);

      mockedChargingSpeedController.determineChargingSpeed.mockResolvedValueOnce(10);

      vi.advanceTimersByTime(2 * 1000);
      await app.stop();

      expect(mockedTeslaClient.setAmpere).toHaveBeenCalledTimes(1);
      expect(eventLogger.onSetAmpere).toHaveBeenCalledOnce();
      expect(mockedChargingSpeedController.determineChargingSpeed).toHaveBeenCalledTimes(2);

      expect(eventLogger.onNoAmpereChange).toHaveBeenCalled();
      expect(mockedChargingSpeedController.determineChargingSpeed).toHaveBeenCalledTimes(2);

      expect(mockedTeslaClient.startCharging).toHaveBeenCalledOnce();
    });

    it('should change ampere if it is not matched with the last sync', async () => {
      // First call to set initial state
      mockedChargingSpeedController.determineChargingSpeed.mockResolvedValueOnce(10);
      await app.start();

      // Second call with different ampere
      mockedChargingSpeedController.determineChargingSpeed.mockResolvedValueOnce(15);
      await app.start();

      // setAmpere should be called twice
      expect(mockedTeslaClient.setAmpere).toHaveBeenCalledTimes(2);
      expect(mockedTeslaClient.setAmpere).toHaveBeenNthCalledWith(0, 10);
    });

    it('should stop charging if ampere is less than 5 and car is charging', async () => {
      // First start charging
      mockedChargingSpeedController.determineChargingSpeed.mockResolvedValueOnce(10);
      await app.start();

      // Then reduce to less than 5
      mockedChargingSpeedController.determineChargingSpeed.mockResolvedValueOnce(3);
      await app.start();

      expect(mockedTeslaClient.stopCharging).toHaveBeenCalled();
    });

    it('should not stop charging if ampere is less than 5 and car is not charging', async () => {
      mockedChargingSpeedController.determineChargingSpeed.mockResolvedValue(3);
      
      await app.start();

      expect(mockedTeslaClient.stopCharging).not.toHaveBeenCalled();
    });

    it('should delay sync by 20 seconds when ampere is reduced by 10', async () => {
      // First set to 15
      mockedChargingSpeedController.determineChargingSpeed.mockResolvedValueOnce(15);
      await app.start();

      // Then reduce to 5
      mockedChargingSpeedController.determineChargingSpeed.mockResolvedValueOnce(5);
      await app.start();

      // Advance time by 20 seconds
      vi.advanceTimersByTime(20000);

      // Verify no additional calls during the delay
      expect(mockedTeslaClient.setAmpere).toHaveBeenCalledTimes(1);
    });

    it('should delay sync by 20 seconds when ampere is increased by 10', async () => {
      // First set to 5
      mockedChargingSpeedController.determineChargingSpeed.mockResolvedValueOnce(5);
      await app.start();

      // Then increase to 15
      mockedChargingSpeedController.determineChargingSpeed.mockResolvedValueOnce(15);
      await app.start();

      // Advance time by 20 seconds
      vi.advanceTimersByTime(20000);

      // Verify no additional calls during the delay
      expect(mockedTeslaClient.setAmpere).toHaveBeenCalledTimes(1);
    });

    it('should re-sync without waiting for full delay if there is sudden drop in production', async () => {
      mockedDataAdapter.getCurrentProduction
        .mockResolvedValueOnce(1000)
        .mockResolvedValueOnce(500); // Sudden drop

      mockedChargingSpeedController.determineChargingSpeed.mockResolvedValue(15);
      
      await expect(app.start()).rejects.toThrow();
    });

    it('should wake up car if last command was sent more than 3 minutes ago', async () => {
      // First start
      mockedChargingSpeedController.determineChargingSpeed.mockResolvedValueOnce(10);
      await app.start();

      // Simulate time passing
      vi.advanceTimersByTime(3 * 60 * 1000 + 1); // 3 minutes and 1 second

      // Start again
      mockedChargingSpeedController.determineChargingSpeed.mockResolvedValueOnce(10);
      await app.start();

      expect(mockedTeslaClient.wakeUpCar).toHaveBeenCalledTimes(2);
    });

    it('should not wake up car if last command was sent less than 3 minutes ago', async () => {
      // First start
      mockedChargingSpeedController.determineChargingSpeed.mockResolvedValueOnce(10);
      await app.start();

      // Simulate time passing
      vi.advanceTimersByTime(2 * 60 * 1000); // 2 minutes

      // Start again
      mockedChargingSpeedController.determineChargingSpeed.mockResolvedValueOnce(10);
      await app.start();

      expect(mockedTeslaClient.wakeUpCar).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop', () => {
    beforeEach(() => {
      app = new App(
        mockedTeslaClient, 
        mockedDataAdapter, 
        mockedChargingSpeedController, 
        false,
        logger,
        eventLogger,
        {
          syncIntervalInMs: 1000,
          vehicleAwakeningTimeInMs: 0,
          inactivityTimeInSeconds: 0.01,
          waitPerAmereInSeconds: 0.002, // 2ms
          extraWaitOnChargeStartInSeconds: 0.001,
          extraWaitOnChargeStopInSeconds: 0.0001,
        },
      );
    });
    
    it('should stop charging and stop the app', async () => {
      // First start charging
      mockedChargingSpeedController.determineChargingSpeed.mockResolvedValueOnce(10);
      await app.start();

      // Then stop
      await app.stop();

      expect(mockedTeslaClient.stopCharging).toHaveBeenCalled();
    });
  });
});
