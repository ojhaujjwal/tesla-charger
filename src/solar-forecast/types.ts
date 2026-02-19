import { Context, Data, Effect } from "effect";

export type SolarForecastPeriod = {
  readonly pv_estimate: number; // kW average for this 30-min period
  readonly pv_estimate10: number; // 10th percentile
  readonly pv_estimate90: number; // 90th percentile
  readonly period_end: string; // ISO 8601 timestamp
  readonly period: string; // "PT30M"
};

export type SolarForecastResult = {
  readonly periods: readonly SolarForecastPeriod[];
};

export class SolarForecastNotAvailableError extends Data.TaggedError(
  "SolarForecastNotAvailable"
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SolarForecast extends Context.Tag("SolarForecast")<
  SolarForecast,
  {
    readonly getForecast: () => Effect.Effect<
      SolarForecastResult,
      SolarForecastNotAvailableError
    >;
  }
>() {}
