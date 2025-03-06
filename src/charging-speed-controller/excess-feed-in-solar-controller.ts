import type { IDataAdapter } from "../data-adapter/types.js";
import type { ChargingSpeedController } from "./types.js";

export class ExcessFeedInSolarController implements ChargingSpeedController {
  public constructor(
    private readonly dataAdapter: IDataAdapter<unknown>,
    private readonly config: {
      maxFeedInAllowed: number;
    }
  ) { }


  async determineChargingSpeed(currentChargingSpeed: number): Promise<number>{

    const {
      voltage,
      export_to_grid: exportingToGrid,
      import_from_grid: importingFromGrid
    } = await this.dataAdapter.getValues(
        ['voltage', 'export_to_grid', 'import_from_grid']
      );
    
    const netExport = exportingToGrid - importingFromGrid;

    console.log('netExport', netExport);

    const excessSolarProduced = netExport + (currentChargingSpeed * voltage);
    const excessSolarGoingWaste = excessSolarProduced - this.config.maxFeedInAllowed;
    console.log('excessSolarGoingWaste', excessSolarGoingWaste);

    // round to nearest multiple of 2
    return Math.ceil((excessSolarGoingWaste / voltage) / 2) * 2;
  }
}
