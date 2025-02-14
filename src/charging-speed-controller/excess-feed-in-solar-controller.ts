import { VOLTAGE } from "../constants.js";
import { IDataAdapter } from "../data-adapter/types.js";
import { ChargingSpeedController } from "./types.js";

export class ExcessFeedInSolarController implements ChargingSpeedController {
  public constructor(
    private readonly dataAdapter: IDataAdapter<unknown>,
    private readonly config: {
      maxFeedInAllowed: number;
    }
  ) { }


  async determineChargingSpeed(currentChargingSpeed: number): Promise<number>{
    const { export_to_grid: exportingToGrid } = await this.dataAdapter.getValues(['export_to_grid']);
    console.log('exportingToGrid', exportingToGrid);

    const excessSolarProduced = exportingToGrid + (currentChargingSpeed * VOLTAGE);
    const excessSolarGoingWaste = excessSolarProduced - this.config.maxFeedInAllowed;
    console.log('excessSolarGoingWaste', excessSolarGoingWaste);

    // round to nearest multiple of 2
    return Math.floor((excessSolarGoingWaste / VOLTAGE) / 2) * 2;
  }
}
