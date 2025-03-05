import { Logger } from "pino";
import { IEventLogger } from "./types.js";

export class EventLogger implements IEventLogger {
  public constructor(private readonly logger: Logger) { }

  public onSetAmpere(ampere: number) {
    this.logger.info(`Setting charging rate to ${ampere}A`);
  }

  public onNoAmpereChange(currentChargingAmpere: number) {
    this.logger.debug(`No ampere change. Current charging ampere: ${currentChargingAmpere}`);
  }
}
