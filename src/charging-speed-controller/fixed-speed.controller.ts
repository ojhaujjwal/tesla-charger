import type { IDataAdapter } from "../data-adapter/types.js";
import type { ChargingSpeedController } from "./types.js";

export class FixedSpeedController implements ChargingSpeedController {
  public constructor(
    private readonly dataAdapter: IDataAdapter<unknown>,
    private readonly config: {
      fixedSpeed: number;
      bufferPower: number;
    }
  ) {
    if (config.fixedSpeed < 0 || config.fixedSpeed > 32) {
      throw new Error('Fixed speed must be between 0 and 32 amperes');
    }
  }

  public async determineChargingSpeed(currentChargingSpeed: number): Promise<number> {
    const {
      voltage,
      export_to_grid: exportingToGrid,
      import_from_grid: importingFromGrid
    } = await this.dataAdapter.getValues(
      ['voltage', 'export_to_grid', 'import_from_grid']
    );

    const netExport = exportingToGrid - importingFromGrid;
    const currentChargingPower = currentChargingSpeed * voltage;
    
    // Calculate available power for charging
    const availablePower = netExport + currentChargingPower - this.config.bufferPower;
    const desiredChargingPower = this.config.fixedSpeed * voltage;

    // Only charge at fixed speed if we have enough power available
    if (availablePower >= desiredChargingPower) {
      return this.config.fixedSpeed;
    }

    return 0;
  }
}
