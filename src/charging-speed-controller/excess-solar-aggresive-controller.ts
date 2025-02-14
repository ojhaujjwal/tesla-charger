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
    const [exportingToGrid, { voltage }] = await Promise.all([
      this.dataAdapter.getGridExportValue(),
      this.dataAdapter.getValues(['voltage']),
    ]);

    console.log('exportingToGrid', exportingToGrid);

    const excessSolar = Math.min(9200, exportingToGrid - this.config.bufferPower + (currentChargingSpeed * voltage)); // 9.2kW max
    
    if (excessSolar > 0) {
      console.log(`Excess solar: ${excessSolar}`);
    }

    if ((excessSolar / voltage) >= 32) {
      return 32;
    }

    // round to nearest multiple of 5
    return Math.floor(excessSolar / voltage / 5) * 5;
  }
}
