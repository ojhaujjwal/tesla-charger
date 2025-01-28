import { VOLTAGE } from "../constants";
import { IDataAdapter } from "../data-adapter/types";
import { ChargingSpeedController } from "./types";

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
    const lowestSolarProduction = await this.dataAdapter.getLowestValueInLastXMinutes('total_active_power', 30);
    const currentLoad = await this.dataAdapter.getCurrentLoad() - currentChargingSpeed * VOLTAGE;
    
    return Math.floor((lowestSolarProduction - currentLoad - this.config.bufferPower) / VOLTAGE);
  }
}
