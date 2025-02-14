import { IDataAdapter } from "../data-adapter/types.js";
import { ChargingSpeedController } from "./types.js";

export class ConservativeController implements ChargingSpeedController {

  public constructor(
    private readonly dataAdapter: IDataAdapter<unknown>,
    private readonly config: {
      bufferPower: number;
    } = { bufferPower: 500 }
  ) { }


  public async determineChargingSpeed(currentChargingSpeed: number): Promise<number> {
    // use last 30 minutes solar production data to determine charging speed
    // also take into account the currentChargingSpeed and current import from grid + export to grid

    const { voltage, current_load: lowestSolarProduction, current_production: currentLoad } = await this.dataAdapter.getValues(['voltage', 'current_load', 'current_production']);
    
    return Math.floor((lowestSolarProduction - currentLoad - currentChargingSpeed * voltage - this.config.bufferPower) / voltage);
  }
}
