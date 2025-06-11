import { Data } from "effect";

export class AbruptProductionDropError extends Data.TaggedError('AbruptProductionDrop')<{
  initialProduction: number;
  currentProduction: number;
}> {}
