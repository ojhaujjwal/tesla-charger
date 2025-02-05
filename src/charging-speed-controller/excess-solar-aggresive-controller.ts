import { VOLTAGE } from "../constants.js";
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
    const exporingToGrid = await this.dataAdapter.getGridExportValue();

    console.log('exportingToGrid', exporingToGrid);

    const excessSolar = Math.min(9200, exporingToGrid - this.config.bufferPower + (currentChargingSpeed * VOLTAGE)); // 9.2kW max
    
    if (excessSolar > 0) {
      console.log(`Excess solar: ${excessSolar}`);
    }

    if ((excessSolar / VOLTAGE) >= 32) {
      return 32;
    }

    // round to nearest multiple of 5
    return Math.floor(excessSolar / VOLTAGE / 5) * 5;
  }
}
