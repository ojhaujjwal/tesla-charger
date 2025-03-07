import type { Logger } from "pino";
import type { IDataAdapter } from "../data-adapter/types.js";
import type { ChargingSpeedController } from "./types.js";

export class ExcessSolarAggresiveController implements ChargingSpeedController {
  public constructor(
    private readonly dataAdapter: IDataAdapter<unknown>,
    private readonly logger: Logger,
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
    //this.logger.info('exportingToGrid', { value: netExport});

    const excessSolar = netExport - this.config.bufferPower + (currentChargingSpeed * voltage);
    
    if (excessSolar > 0) {
      //this.logger.info('Excess solar', {  value: excessSolar });
      console.log(`Excess solar: ${excessSolar}`);
    }

    if ((excessSolar / voltage) >= 32) {
      return 32;
    }

    // round to nearest multiple of 5
    return Math.max(0, Math.floor(excessSolar / voltage / 5) * 5);
  }
}
