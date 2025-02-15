import { IDataAdapter } from "../data-adapter/types.js";
import { ChargingSpeedController } from "./types.js";

export class ExcessSolarAggresiveController implements ChargingSpeedController {
  public constructor(
    private readonly dataAdapter: IDataAdapter<unknown>,
    private readonly config: {
      bufferPower: number;
    }
  ) { }

  public async determineChargingSpeed(currentChargingSpeed: number): Promise<number> {
    const {
      voltage,
      export_to_grid: exportingToGrid,
      import_from_grid: importingFromGrid
    } = await this.dataAdapter.getValues(
        ['voltage', 'export_to_grid', 'import_from_grid']
      );
    
    const netExport = exportingToGrid - importingFromGrid;

    console.log('exportingToGrid', netExport);

    const excessSolar = netExport - this.config.bufferPower + (currentChargingSpeed * voltage);
    
    if (excessSolar > 0) {
      console.log(`Excess solar: ${excessSolar}`);
    }

    if ((excessSolar / voltage) >= 32) {
      return 32;
    }

    // round to nearest multiple of 5
    return Math.max(0, Math.floor(excessSolar / voltage / 5) * 5);
  }
}
