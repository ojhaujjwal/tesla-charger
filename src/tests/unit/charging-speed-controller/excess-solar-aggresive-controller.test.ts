import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
import { type MockedObject } from 'vitest';
import { ExcessSolarAggresiveController } from '../../../charging-speed-controller/excess-solar-aggresive-controller.js';
import { type IDataAdapter } from '../../../data-adapter/types.js';
import { pino } from 'pino';

describe('ExcessSolarAggresiveController', () => {
  let mockDataAdapter: MockedObject<IDataAdapter<unknown>>;
  let controller: ExcessSolarAggresiveController;

  beforeEach(() => {
    mockDataAdapter = {
      authenticate: vi.fn(),
      getCurrentProduction: vi.fn(),
      getVoltage: vi.fn(),
      getDailyImportValue: vi.fn(),
      getValues: vi.fn(),
      getLowestValueInLastXMinutes: vi.fn()
    };

    // Create controller with mock adapter and config
    controller = new ExcessSolarAggresiveController(mockDataAdapter, pino(), {
      bufferPower: 100
    });
  });

  describe('determineChargingSpeed', () => {
    it('should limit charging speed to 32A', async () => {
      // Mock data to simulate high excess solar
      mockDataAdapter.getValues.mockResolvedValue({ 
        voltage: 230,
        current_production: 0,
        current_load: 0,
        daily_import: 0,
        export_to_grid: 10000,
        import_from_grid: 0
      });

      const chargingSpeed = await controller.determineChargingSpeed(0);
      expect(chargingSpeed).toBe(32);
    });

    it('should round charging speed to nearest multiple of 5', async () => {
      // Mock data to simulate moderate excess solar
      mockDataAdapter.getValues.mockResolvedValue({ 
        voltage: 230,
        current_production: 0,
        current_load: 0,
        daily_import: 0,
        export_to_grid: 2000,
        import_from_grid: 0
      });

      const chargingSpeed = await controller.determineChargingSpeed(10);
      expect(chargingSpeed).toBeGreaterThan(0);
      expect(chargingSpeed % 5).toBe(0);
    });

    it('should return 0 when no excess solar is available after buffer', async () => {
      // Mock data to simulate minimal excess solar
      mockDataAdapter.getValues.mockResolvedValue({ 
        voltage: 230,
        current_production: 0,
        current_load: 0,
        daily_import: 0,
        export_to_grid: 50,
        import_from_grid: 0
      });

      const chargingSpeed = await controller.determineChargingSpeed(0);
      expect(chargingSpeed).toBe(0);
    });

    it('should return 0 when importing from grid', async () => {
      // Mock data to simulate importing from grid
      mockDataAdapter.getValues.mockResolvedValue({ 
        voltage: 230,
        current_production: 0,
        current_load: 0,
        daily_import: 0,
        export_to_grid: 0,
        import_from_grid: 1230
      });

      const chargingSpeed = await controller.determineChargingSpeed(0);
      expect(chargingSpeed).toBe(0);
    });

    it.each([
      [1800, 5],
      [4600, 15],
      [4700, 20],
      [4800, 20],
    ])('should calculate excess solar correctly with current charging speed', async (exportingToGrid, chargingSpeed) => {
      // Mock data to test excess solar calculation including current charging speed
      mockDataAdapter.getValues.mockResolvedValue({ 
        voltage: 230,
        current_production: 0,
        current_load: 0,
        daily_import: 0,
        export_to_grid: exportingToGrid,
        import_from_grid: 0,
      });

      const resultingChargingSpeed = await controller.determineChargingSpeed(10);
      expect(resultingChargingSpeed).toEqual(10 + chargingSpeed);
    });
  });
});
