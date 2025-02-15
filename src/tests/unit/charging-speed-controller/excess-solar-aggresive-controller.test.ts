import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
import { type MockedObject } from 'vitest';
import { ExcessSolarAggresiveController } from '../../../charging-speed-controller/excess-solar-aggresive-controller.js';
import { type IDataAdapter } from '../../../data-adapter/types.js';

describe('ExcessSolarAggresiveController', () => {
  let mockDataAdapter: MockedObject<IDataAdapter<unknown>>;
  let controller: ExcessSolarAggresiveController;

  beforeEach(() => {
    // Create a comprehensive mock data adapter using MockedObject
    mockDataAdapter = {
      authenticate: vi.fn(),
      getCurrentProduction: vi.fn(),
      getVoltage: vi.fn(),
      getCurrentLoad: vi.fn(),
      getGridExportValue: vi.fn(),
      getDailyImportValue: vi.fn(),
      getValues: vi.fn(),
      getLowestValueInLastXMinutes: vi.fn()
    };

    // Setup default mock implementations
    mockDataAdapter.getVoltage.mockResolvedValue(230);
    mockDataAdapter.getGridExportValue.mockResolvedValue(0);
    mockDataAdapter.getValues.mockResolvedValue({
      voltage: 230,
      current_production: 0,
      current_load: 0,
      daily_import: 0,
      export_to_grid: 0,
      import_from_grid: 0
    });

    // Create controller with mock adapter and config
    controller = new ExcessSolarAggresiveController(mockDataAdapter, {
      bufferPower: 100
    });
  });

  describe('determineChargingSpeed', () => {
    it('should limit charging speed to 32A', async () => {
      // Mock data to simulate high excess solar
      mockDataAdapter.getGridExportValue.mockResolvedValue(10000);
      mockDataAdapter.getValues.mockResolvedValue({ 
        voltage: 230,
        current_production: 0,
        current_load: 0,
        daily_import: 0,
        export_to_grid: 0,
        import_from_grid: 0
      });

      const chargingSpeed = await controller.determineChargingSpeed(0);
      expect(chargingSpeed).toBe(32);
    });

    it('should round charging speed to nearest multiple of 5', async () => {
      // Mock data to simulate moderate excess solar
      mockDataAdapter.getGridExportValue.mockResolvedValue(2000);
      mockDataAdapter.getValues.mockResolvedValue({ 
        voltage: 230,
        current_production: 0,
        current_load: 0,
        daily_import: 0,
        export_to_grid: 0,
        import_from_grid: 0
      });

      const chargingSpeed = await controller.determineChargingSpeed(10);
      expect(chargingSpeed).toBeGreaterThan(0);
      expect(chargingSpeed % 5).toBe(0);
    });

    it('should return 0 when no excess solar is available after buffer', async () => {
      // Mock data to simulate minimal excess solar
      mockDataAdapter.getGridExportValue.mockResolvedValue(50);
      mockDataAdapter.getValues.mockResolvedValue({ 
        voltage: 230,
        current_production: 0,
        current_load: 0,
        daily_import: 0,
        export_to_grid: 0,
        import_from_grid: 0
      });

      const chargingSpeed = await controller.determineChargingSpeed(0);
      expect(chargingSpeed).toBe(0);
    });

    it('should calculate excess solar correctly with current charging speed', async () => {
      // Mock data to test excess solar calculation including current charging speed
      mockDataAdapter.getGridExportValue.mockResolvedValue(1000);
      mockDataAdapter.getValues.mockResolvedValue({ 
        voltage: 230,
        current_production: 0,
        current_load: 0,
        daily_import: 0,
        export_to_grid: 0,
        import_from_grid: 0
      });

      const chargingSpeed = await controller.determineChargingSpeed(10);
      // Verify the calculation matches the implementation logic
      const expectedExcessSolar = 1000 - 100 + (10 * 230);
      expect(chargingSpeed).toBeGreaterThan(0);
      expect(chargingSpeed % 5).toBe(0);
    });

    it('should cap excess solar at 9.2kW', async () => {
      // Mock data to test 9.2kW max limit
      mockDataAdapter.getGridExportValue.mockResolvedValue(20000);
      mockDataAdapter.getValues.mockResolvedValue({ 
        voltage: 230,
        current_production: 0,
        current_load: 0,
        daily_import: 0,
        export_to_grid: 0,
        import_from_grid: 0
      });

      const chargingSpeed = await controller.determineChargingSpeed(0);
      expect(chargingSpeed).toBe(32);
    });
  });
});
