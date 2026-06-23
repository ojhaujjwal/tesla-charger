import { Data } from "effect";

export class GridImportExhaustedError extends Data.TaggedError("GridImportExhausted")<{
  initialProduction: number;
  currentProduction: number;
}> {}
