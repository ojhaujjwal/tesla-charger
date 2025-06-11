import type { IEventLogger } from "./types.js";
import { Effect } from "effect";

export class EventLogger implements IEventLogger {

  public onSetAmpere(ampere: number) {
    return Effect.log(`Setting charging rate to ${ampere}A`);
  }

  public onNoAmpereChange(currentChargingAmpere: number) {
    return Effect.log(`No ampere change. Current charging ampere: ${currentChargingAmpere}`);
  }
}
