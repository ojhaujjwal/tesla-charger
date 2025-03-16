import type { IDataAdapter } from "../data-adapter/types.js";
import type { ChargingSpeedController } from "./types.js";

export class ConservativeController implements ChargingSpeedController {

  public constructor(
    private readonly dataAdapter: IDataAdapter<unknown>,
    private readonly config: {
      bufferPower: number;
    } = { bufferPower: 100 }
  ) { }


  public async determineChargingSpeed(currentChargingSpeed: number): Promise<number> {
    // use last 30 minutes solar production data to determine charging speed
    // also take into account the currentChargingSpeed and current import from grid + export to grid

    const { voltage, current_load: currentLoad } = await this.dataAdapter.getValues(['voltage', 'current_load', 'current_production']);
    const lowestSolarProduction = await this.dataAdapter.getLowestValueInLastXMinutes('current_production', 30);
    
    return Math.floor((lowestSolarProduction - currentLoad - currentChargingSpeed * voltage - this.config.bufferPower) / voltage);
  }
}
