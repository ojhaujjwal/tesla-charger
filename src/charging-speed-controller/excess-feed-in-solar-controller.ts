import { VOLTAGE } from "../constants";
import { IDataAdapter } from "../data-adapter/types";
import { ChargingSpeedController } from "./types";

export class ExcessFeedInSolarController implements ChargingSpeedController {
  public constructor(
    private readonly dataAdapter: IDataAdapter<unknown>,
    private readonly config: {
      maxFeedInAllowed: number;
    }
  ) { }


  async determineChargingSpeed(currentChargingSpeed: number): Promise<number>{
    const exporingToGrid = await this.dataAdapter.getGridExportValue();
    console.log('exportingToGrid', exporingToGrid);

    const excessSolarProduced = exporingToGrid + (currentChargingSpeed * VOLTAGE);
    const excessSolarGoingWaste = excessSolarProduced - this.config.maxFeedInAllowed;
    console.log('excessSolarGoingWaste', excessSolarGoingWaste);

    // round to nearest multiple of 2
    return Math.floor((excessSolarGoingWaste / VOLTAGE) / 2) * 2;
  }
}